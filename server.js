"use strict";

const express = require("express");
const axios = require("axios");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const https = require("https");
const io = require("socket.io-client");

const app = express();
app.use(express.json());

const CONFIG = {
    apiBaseUrl: process.env.API_BASE_URL || "https://trackweaving.com/api/v1",
    workspaceId: process.env.WORKSPACE_ID || "6a6afb6efb89777aa538ebd8",
    apiKey: process.env.API_KEY || "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21",
    port: parseInt(process.env.PORT || "3001", 10),
    dataPushIntervalMs: parseInt(process.env.DATA_PUSH_INTERVAL_MS || "5000",10),
    fullRefreshIntervalMs: parseInt(process.env.FULL_REFRESH_INTERVAL_MS || "60000",10),
    socketConnectTimeoutMs: parseInt(process.env.SOCKET_CONNECT_TIMEOUT_MS || "10000",10),
    logVariableChanges: process.env.LOG_VARIABLE_CHANGES === "true",
    pendingShiftLogsPath: process.env.PENDING_SHIFT_LOGS_PATH || path.join(process.cwd(), "pending-shift-logs.json"),
};

const axiosInstance = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({
        keepAlive: false,
        maxSockets: 10,
    }),
});

const IDS = {
    currentShift: 5037,
    loomSpeed: 407,
    loomStateCode: 423,
    stopReasonCode: 427,
    stopReasonText: 1780,
    weftDensity: 53,
    weftDensityDisplay: 1997,
    weftDensityDisplayInch: 3077,
    remainingWarp: 4703,
    warpCompletionDateTime: 9864,
    lengthMeter: 8302,
    lengthYard: 8313,
    picks: 8324,
    pieces: 8335,
    shiftSpeed: 8346,
    efficiency: 8357,
    totalTimeMinutes: 8368,
    runtimeMinutes: 8379,
    totalStopCount: 8390,
    totalStopMinutes: 8401,
    h1StopCount: 8412,
    h1StopMinutes: 8423,
    h2StopCount: 8434,
    h2StopMinutes: 8445,
    warpStopCount: 8456,
    warpStopMinutes: 8467,
    otherStopCount: 8478,
    otherStopMinutes: 8489,
};

const TRACKED_IDS = new Set(Object.values(IDS));

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

let machineData = {};

const readers = new Map();

let shuttingDown = false;
let dataPushTimer = null;
let machineSyncTimer = null;
let pendingShiftLogs = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
|--------------------------------------------------------------------------
| Value helpers
|--------------------------------------------------------------------------
*/

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
}

function numberWithTwoDecimalsOrNull(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Number(parsed.toFixed(2));
}

function integerOrNull(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Math.trunc(parsed);
}

function textOrNull(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();

    return text || null;
}

function normalizeShift(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const rawValue = String(value).trim();
    if (!rawValue) {
        return null;
    }

    const normalized = rawValue.toUpperCase().replace(/\s+/g, "").replace("班", "").replace("SHIFT", "");
    const shiftMap = { A: 0, B: 1, C: 2, D: 3, "1": 0, "2": 1, "3": 2, "4": 3 };

    return {
        raw: rawValue,
        number: Object.prototype.hasOwnProperty.call(shiftMap, normalized) ? shiftMap[normalized] : null,
        code: normalized
    };
}

function isIntegerShift(value) {
    return Number.isInteger(value);
}

function resolveStoredShift(existing) {
    if (isIntegerShift(existing.shift)) {
        return existing.shift;
    }

    const rawShift = Array.isArray(existing.rawData) ? existing.rawData[0] : null;

    return isIntegerShift(rawShift) ? rawShift : null;
}

function hasShiftChanged(previousShift, previousShiftRaw, currentShift, currentShiftRaw) {
    if (currentShiftRaw != null && previousShiftRaw != null && String(currentShiftRaw) !== String(previousShiftRaw)) {
        return true;
    }

    return isIntegerShift(currentShift) && isIntegerShift(previousShift) && currentShift !== previousShift;
}

/*
|--------------------------------------------------------------------------
| Machine data initialization
|--------------------------------------------------------------------------
*/

function createEmptyStopsData() {
    return {
        warp: [],
        other: [],
        h1: [],
        h2: [],
    };
}

function initMachineData(machine) {
    const machineId = String(machine.id);

    const existing = machineData[machineId] || {};
    const existingShift = resolveStoredShift(existing);

    machineData[machineId] = {
        ...existing,
        displayType: machine.displayType || "haiwell",
        deviceType: machine.deviceType || "socketio",
        ip: machine.ip,
        connected: false,
        connectionError: null,
        updatedTime: existing.updatedTime || null,
        lastDataTime: existing.lastDataTime || null,
        stopCount: existing.stopCount || 0,
        stopsData: existing.stopsData || createEmptyStopsData(),
        lastStopTime: existing.lastStopTime || null,
        lastStartTime: existing.lastStartTime || null,
        stop: Number.isFinite(Number(existing.stop))
            ? Number(existing.stop)
            : 0,
        stopReasonText: existing.stopReasonText || null,
        shift: existingShift,
        shiftCode: existing.shiftCode || null,
        shiftRaw: existing.shiftRaw != null ? existing.shiftRaw : null,
        rawData: existing.rawData || {},
    };

    return machineData[machineId];
}

/*
|--------------------------------------------------------------------------
| Pending closed-shift logs
|
| Completed shift snapshots are written to disk immediately so they survive
| WiFi outages and gateway restarts. They are flushed to the shift-log API
| only after a successful live data push.
|--------------------------------------------------------------------------
*/

function loadPendingShiftLogs() {
    try {
        if (!fs.existsSync(CONFIG.pendingShiftLogsPath)) {
            pendingShiftLogs = [];
            return;
        }

        const parsed = JSON.parse(fs.readFileSync(CONFIG.pendingShiftLogsPath, "utf8"));
        if (Array.isArray(parsed)) {
            pendingShiftLogs = parsed;
        } else if (parsed && Array.isArray(parsed.logs)) {
            pendingShiftLogs = parsed.logs;
        } else {
            pendingShiftLogs = [];
        }
    } catch (error) {
        console.error("Failed to load pending shift logs:", error.message);
        pendingShiftLogs = [];
    }
}

function persistPendingShiftLogs() {
    const tmpPath = `${CONFIG.pendingShiftLogsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ logs: pendingShiftLogs }, null, 2));
    fs.renameSync(tmpPath, CONFIG.pendingShiftLogsPath);
}

function enqueueClosedShiftLog(machineId, state, endedAt) {
    pendingShiftLogs.push({
        id: `${machineId}-${Date.now()}-${state.shift ?? "x"}`,
        machineId,
        updatedTime: endedAt,
        lastStopTime: state.lastStopTime || null,
        lastStartTime: state.lastStartTime || null,
        stop: state.stop,
        stopsData: clone(state.stopsData || createEmptyStopsData()),
        rawData: clone(state.rawData || []),
        displayType: state.displayType,
        stopCount: state.stopCount || 0,
        shift: state.shift,
    });

    try {
        persistPendingShiftLogs();
        console.log(
            `[${machineId}] Stored closed shift locally (${pendingShiftLogs.length} pending)`,
        );
    } catch (error) {
        console.error(`[${machineId}] Failed to store closed shift:`, error.message);
    }
}

function removePendingShiftLogs(ids) {
    const remove = new Set(ids);
    pendingShiftLogs = pendingShiftLogs.filter((log) => !remove.has(log.id));

    try {
        persistPendingShiftLogs();
    } catch (error) {
        console.error("Failed to update pending shift logs:", error.message);
    }
}

async function flushPendingShiftLogs() {
    if (!pendingShiftLogs.length) {
        return;
    }

    const toFlush = pendingShiftLogs.slice();

    await axiosInstance.post(`${CONFIG.apiBaseUrl}/machine-logs/shift`, {
        logs: toFlush,
        workspaceId: CONFIG.workspaceId,
        apiKey: CONFIG.apiKey,
    });

    removePendingShiftLogs(toFlush.map((log) => log.id));
    console.log(`Flushed ${toFlush.length} closed shift log(s)`);
}

/*
|--------------------------------------------------------------------------
| Stoppage classification
|--------------------------------------------------------------------------
|
| We preserve the original stoppage code and text.
|
| Text classification is used because the complete code mapping
| for every possible Haiwell stoppage code is not yet confirmed.
|
*/

function classifyStop(stopCode, stopText) {
    const text = String(stopText || "").trim().toLowerCase();

    if (/\bh1\b/.test(text) || /c[1-8]\s*h1/.test(text) || /weft.*h1/.test(text)) {
        return "h1";
    }

    if (/\bh2\b/.test(text) || /c[1-8]\s*h2/.test(text) || /weft.*h2/.test(text)) {
        return "h2";
    }

    if (text.includes("warp") || text.includes("经停") || text.includes("经纱")) {
        return "warp";
    }

    void stopCode;

    return "other";
}

/*
|--------------------------------------------------------------------------
| Stop completion
|--------------------------------------------------------------------------
*/

function completeCurrentStop(machineId) {
    const data = machineData[machineId];

    if (!data || !data.lastStopTime) {
        return;
    }

    const now = moment().utc();
    const stopStart = moment(data.lastStopTime);
    const duration = Math.max(0, now.diff(stopStart, "seconds"));
    const category = classifyStop(data.stop, data.stopReasonText);
    const entry = {
        start: data.lastStopTime,
        end: now.format(),
        statusCode: data.stop,
        category,
        duration,
    };

    /*
     * Same rule as your existing program:
     * count only stoppages lasting at least 60 seconds.
     */
    if (duration >= 60) {
        data.stopCount += 1;
    }

    if (!data.stopsData[category]) {
        data.stopsData[category] = [];
    }

    data.stopsData[category].push(entry);
}

/*
|--------------------------------------------------------------------------
| Weft density normalization
|--------------------------------------------------------------------------
*/

function getWeftDensity(values) {
    const rawDensity = numberOrNull(values.get(IDS.weftDensity));
    if (rawDensity !== null) {
        return {
            value: rawDensity,
            sourceId: IDS.weftDensity,
            rawValue: values.get(IDS.weftDensity),
        };
    }

    const displayDensity = numberOrNull(values.get(IDS.weftDensityDisplay));

    if (displayDensity !== null) {
        return {
            value: displayDensity * 100,
            sourceId: IDS.weftDensityDisplay,
            rawValue: values.get(IDS.weftDensityDisplay),
        };
    }

    return {
        value: null,
        sourceId: null,
        rawValue: null,
    };
}

/*
|--------------------------------------------------------------------------
| Machine state calculation
|--------------------------------------------------------------------------
*/

function getMachineState(values) {
    const speed = numberOrNull(values.get(IDS.loomSpeed));
    const stateCode = integerOrNull(values.get(IDS.loomStateCode));
    let running = null;

    /*
     * The panel project treats state >= 20
     * as running.
     */
    if(speed !== null && speed > 20) {
        running = true;
    } else if (stateCode !== null) {
        running = stateCode >= 20;
    } else if (speed !== null) {
        running = speed > 0;
    }

    return {
        speed,
        stateCode,
        running,
        status: running === true ? "RUNNING" : running === false ? "STOPPED": "UNKNOWN",
    };
}

/*
|--------------------------------------------------------------------------
| Haiwell reader
|--------------------------------------------------------------------------
*/

class HaiwellMachineReader {
    constructor(machine) {
        this.machine = machine;
        this.machineId = String(machine.id);
        this.hmiUrl = this.createHmiUrl(machine);
        this.socket = null;
        this.values = new Map();
        this.updatedAt = new Map();
        this.fullRefreshTimer = null;
        this.destroyed = false;
        this.lastPayloadAt = null;
    }

    createHmiUrl(machine) {
        if (machine.hmiUrl) {
            return machine.hmiUrl;
        }

        if (!machine.ip) {
            throw new Error(`Machine ${machine.id} has no IP address`);
        }

        if (String(machine.ip).startsWith("http://") || String(machine.ip).startsWith("https://")) {
            return String(machine.ip);
        }

        return `http://${machine.ip}`;
    }

    start() {
        if (this.destroyed) {
            return;
        }

        initMachineData(this.machine);

        this.connect();
    }

    connect() {
        if (this.destroyed || this.socket) {
            return;
        }
        console.log(`[${this.machineId}] Connecting to ${this.hmiUrl}`);
        const socket = io(this.hmiUrl, {
            path: "/socket.io",
            transports: ["websocket"],
            forceNew: true,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000,
            timeout: CONFIG.socketConnectTimeoutMs,
        });

        this.socket = socket;

        /*
         * Older Socket.IO v2 fallback.
         *
         * We intercept the raw packet because some
         * Haiwell builds package events differently.
         */
        const originalOnevent = socket.onevent;

        socket.onevent = (packet) => {
            try {
                const packetData = Array.isArray(packet && packet.data)
                    ? packet.data
                    : [];

                const eventName = packetData[0];
                if (eventName === "return var to browser") {
                    const payloads = packetData.slice(1);
                    for (const payload of payloads) {
                        this.storePayload(payload);
                    }
                }
            } catch (error) {
                console.error(
                    `[${this.machineId}] Incoming packet error:`,
                    error.message,
                );
            }

            return originalOnevent.call(socket, packet);
        };

        socket.on("connect", () => {
            const state = machineData[this.machineId];

            state.connected = true;
            state.connectionError = null;
            state.socketId = socket.id;

            console.log(`[${this.machineId}] Connected: ${socket.id}`);

            this.requestAllVariables();

            this.startFullRefreshTimer();
        });

        socket.on("disconnect", (reason) => {
            const state = machineData[this.machineId];

            if (state) {
                state.connected = false;
                state.connectionError = reason;
            }

            console.log(`[${this.machineId}] Disconnected: ${reason}`);
        });

        socket.on("connect_error", (error) => {
            const state = machineData[this.machineId];

            if (state) {
                state.connected = false;
                state.connectionError = error.message;
            }

            console.log(
                `[${this.machineId}] Connection error: ${error.message}`,
            );
        });

        socket.on("reconnect", () => {
            console.log(`[${this.machineId}] Reconnected`);

            this.requestAllVariables();
        });
    }

    requestAllVariables() {
        if (!this.socket || !this.socket.connected) {
            return;
        }

        this.socket.emit("get all variables");
    }

    startFullRefreshTimer() {
        if (this.fullRefreshTimer) {
            clearInterval(this.fullRefreshTimer);
        }

        this.fullRefreshTimer = setInterval(() => {
            this.requestAllVariables();
        }, CONFIG.fullRefreshIntervalMs);
    }

    storePayload(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return;
        }

        const now = Date.now();

        let relevantValueChanged = false;

        for (const [idText, rawValue] of Object.entries(payload)) {
            const id = Number(idText);

            if (!Number.isInteger(id)) {
                continue;
            }

            const previous = this.values.get(id);
            const changed = !this.values.has(id) || previous !== rawValue;
            this.values.set(id, rawValue);
            this.updatedAt.set(id, now);
            if (TRACKED_IDS.has(id) && changed) {
                relevantValueChanged = true;

                if (CONFIG.logVariableChanges) {
                    console.log(
                        `[${this.machineId}] ${id} = ${JSON.stringify(rawValue)}`,
                    );
                }
            }
        }

        this.lastPayloadAt = new Date().toISOString();

        /*
         * Process immediately when a tracked value changes.
         */
        if (relevantValueChanged) {
            this.processMachineData();
        }
    }

    processMachineData() {
        const state = machineData[this.machineId] || initMachineData(this.machine);
        const nowUtc = moment().utc().format();
        const machineState = getMachineState(this.values);
        const shiftInfo = normalizeShift(this.values.get(IDS.currentShift));
        const currentShift = shiftInfo ? shiftInfo.number : null;
        const currentShiftCode = shiftInfo ? shiftInfo.code : null;
        const currentShiftRaw = shiftInfo ? shiftInfo.raw : null;
        const stopReasonCode = integerOrNull(this.values.get(IDS.stopReasonCode));
        const stopReasonText = textOrNull(this.values.get(IDS.stopReasonText));
        let currentStop = 0;

        if (machineState.running === false) {
            currentStop = stopReasonCode || machineState.stateCode || 1;
        }

        if (state.stop === 0 && currentStop !== 0) {
            state.lastStopTime = nowUtc;
            state.stopReasonText = stopReasonText;
        }
        if (state.stop !== 0 && currentStop === 0) {
            state.lastStartTime = nowUtc;
            completeCurrentStop(this.machineId);
            state.lastStopTime = null;
        }
        if (state.stop !== 0 && currentStop !== 0 && (state.stop !== currentStop || (stopReasonText && state.stopReasonText !== stopReasonText))) {
            completeCurrentStop(this.machineId);
            state.lastStopTime = nowUtc;
        }

        const previousShift = state.shift;
        const previousShiftRaw = state.shiftRaw;
        const panelShiftChanged = hasShiftChanged(
            previousShift,
            previousShiftRaw,
            currentShift,
            currentShiftRaw,
        );

        if (panelShiftChanged) {
            console.log(`[${this.machineId}] Shift changed: ` + `${previousShiftRaw} -> ${currentShiftRaw}`);
            if (state.stop !== 0 && currentStop !== 0) {
                completeCurrentStop(this.machineId);
                state.lastStopTime = nowUtc;
            }
            enqueueClosedShiftLog(this.machineId, state, nowUtc);
            state.stopCount = 0;
            state.stopsData = createEmptyStopsData();
            if (currentStop === 0) {
                state.lastStartTime = nowUtc;
            }
        }

        state.stop = currentStop;
        state.stopReasonCode = stopReasonCode;
        state.stopReasonText = stopReasonText;
        if(shiftInfo) {
            state.shiftCode = currentShiftCode;
            state.shiftRaw = currentShiftRaw;
        }
        state.shift = currentShift;
        state.updatedTime = nowUtc;
        state.lastDataTime = this.lastPayloadAt;
        state.connected = Boolean(this.socket && this.socket.connected);
        state.connectionError = null;
        state.rawData = this.buildRawData();
    }

    buildRawData() {
        const density = getWeftDensity(this.values);
        const shiftInfo = normalizeShift(this.values.get(IDS.currentShift));
        let rawData = [
            shiftInfo ? shiftInfo.number : null,
            integerOrNull(this.values.get(IDS.stopReasonCode)) ? (numberOrNull(this.values.get(IDS.loomSpeed)) >= 20 ? 0:  integerOrNull(this.values.get(IDS.stopReasonCode))) : 0,
            textOrNull(this.values.get(IDS.stopReasonText)) ? textOrNull(this.values.get(IDS.stopReasonText)) : '',
            numberOrNull(this.values.get(IDS.loomSpeed)),
            numberOrNull(this.values.get(IDS.weftDensityDisplay)),
            integerOrNull(this.values.get(IDS.remainingWarp)),
            textOrNull(this.values.get(IDS.warpCompletionDateTime)),
            numberWithTwoDecimalsOrNull(this.values.get(IDS.lengthMeter)),
            integerOrNull(this.values.get(IDS.picks)),
            numberWithTwoDecimalsOrNull(this.values.get(IDS.efficiency)),
            integerOrNull(this.values.get(IDS.runtimeMinutes)),
            integerOrNull(this.values.get(IDS.warpStopCount)),
            integerOrNull(this.values.get(IDS.warpStopMinutes)),
            integerOrNull(this.values.get(IDS.h1StopCount)),
            integerOrNull(this.values.get(IDS.h1StopMinutes)),
            integerOrNull(this.values.get(IDS.h2StopCount)),
            integerOrNull(this.values.get(IDS.h2StopMinutes)),
            integerOrNull(this.values.get(IDS.otherStopCount)),
            integerOrNull(this.values.get(IDS.otherStopMinutes))
       ];

       return rawData;
    }

    getHealth() {
        const machineState = machineData[this.machineId];

        return {
            machineId: this.machineId,
            ip: this.machine.ip,
            hmiUrl: this.hmiUrl,
            connected: Boolean(this.socket && this.socket.connected),
            socketId: this.socket ? this.socket.id : null,
            lastPayloadAt: this.lastPayloadAt,
            receivedVariableCount: this.values.size,
            connectionError: machineState ? machineState.connectionError : null,
        };
    }

    updateMachine(machine) {
        this.machine = machine;

        const newUrl = this.createHmiUrl(machine);

        /*
         * Reconnect only when the HMI URL changed.
         */
        if (newUrl !== this.hmiUrl) {
            console.log(
                `[${this.machineId}] HMI address changed from ${this.hmiUrl} to ${newUrl}`,
            );

            this.stop();

            this.destroyed = false;
            this.hmiUrl = newUrl;

            this.start();
        }
    }

    stop() {
        this.destroyed = true;

        if (this.fullRefreshTimer) {
            clearInterval(this.fullRefreshTimer);

            this.fullRefreshTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.close();
            } catch (error) {
                console.error(
                    `[${this.machineId}] Socket close error:`,
                    error.message,
                );
            }

            this.socket = null;
        }

        const state = machineData[this.machineId];

        if (state) {
            state.connected = false;
        }
    }
}

/*
|--------------------------------------------------------------------------
| API machine filtering
|--------------------------------------------------------------------------
*/

function isHaiwellMachine(machine) {
    const displayType = String(machine.displayType || "").toLowerCase();

    const deviceType = String(machine.deviceType || "").toLowerCase();

    return (["haiwell"].includes(displayType));
}

/*
|--------------------------------------------------------------------------
| Machine list API
|--------------------------------------------------------------------------
*/

async function fetchMachineList() {
    const response = await axiosInstance.post(
        `${CONFIG.apiBaseUrl}/machine-logs/machine-list`,
        {
            workspaceId: CONFIG.workspaceId,
            apiKey: CONFIG.apiKey,
        },
    );

    const responseData = response.data && response.data.data ? response.data.data : {};

    return {
        machines: Array.isArray(responseData.machines) ? responseData.machines : [],
        previousMachineData: responseData.machineData || {},
    };
}

/*
|--------------------------------------------------------------------------
| Synchronize machine connections
|--------------------------------------------------------------------------
*/

async function syncMachines() {
    const { machines, previousMachineData } = await fetchMachineList();

    /*
     * Preload server-provided state only when
     * the local machine has no state yet.
     */
    for (const [machineId, data] of Object.entries(previousMachineData)) {
        if (!machineData[machineId]) {
            machineData[machineId] = data;
        }
    }

    const haiwellMachines = machines.filter(isHaiwellMachine);

    const activeMachineIds = new Set(
        haiwellMachines.map((machine) => String(machine.id)),
    );

    /*
     * Add or update readers.
     */
    for (const machine of haiwellMachines) {
        const machineId = String(machine.id);
        initMachineData(machine);
        const existingReader = readers.get(machineId);
        if (existingReader) {
            existingReader.updateMachine(machine);

            continue;
        }
        try {
            const reader = new HaiwellMachineReader(machine);
            readers.set(machineId, reader);
            reader.start();
        } catch (error) {
            console.error(
                `[${machineId}] Reader initialization error:`,
                error.message,
            );
        }
    }

    /*
     * Remove machines no longer returned by API.
     */
    for (const [machineId, reader] of readers.entries()) {
        if (!activeMachineIds.has(machineId)) {
            console.log(`[${machineId}] Removing machine reader`);
            reader.stop();
            readers.delete(machineId);
            delete machineData[machineId];
        }
    }

    console.log(`Haiwell machines active: ${readers.size}`);
}

/*
|--------------------------------------------------------------------------
| Initial machine list retry
|--------------------------------------------------------------------------
*/

async function initAllMachines() {
    let retryDelay = 5000;

    while (!shuttingDown) {
        try {
            await syncMachines();

            return;
        } catch (error) {
            console.error("Machine-list error:", error.response && error.response.data ? error.response.data : error.message);
            console.log(`Retrying machine list in ${retryDelay / 1000} seconds`);

            await sleep(retryDelay);

            retryDelay = Math.min(retryDelay * 2, 60000);
        }
    }

}

/*
|--------------------------------------------------------------------------
| Prepare logs for server
|--------------------------------------------------------------------------
*/

function getDataToSend() {
    const dataToSend = {};

    for (const [machineId, data] of Object.entries(machineData)) {
        if (!data.updatedTime) {
            continue;
        }

        const dataAgeHours = moment().diff(
            moment(data.updatedTime),
            "hours",
            true,
        );

        /*
         * Same behavior as existing application:
         * do not send very old stale machine data.
         */
        if (dataAgeHours < 1) {
            dataToSend[machineId] = {
                updatedTime: data.updatedTime,
                lastStopTime: data.lastStopTime,
                lastStartTime: data.lastStartTime,
                stop: data.stop,
                stopsData: data.stopsData,
                rawData: data.rawData,
                displayType: data.displayType,
                stopCount: data.stopCount
            };
        }
    }

    return dataToSend;
}

/*
|--------------------------------------------------------------------------
| Data push loop
|--------------------------------------------------------------------------
*/

let dataPushDelay = CONFIG.dataPushIntervalMs;

async function dataPushLoop() {
    if (shuttingDown) {
        return;
    }

    try {
        const logs = getDataToSend();

        await axiosInstance.post(`${CONFIG.apiBaseUrl}/machine-logs`, {
            logs,
            workspaceId: CONFIG.workspaceId,
            apiKey: CONFIG.apiKey,
        });

        dataPushDelay = CONFIG.dataPushIntervalMs;

        try {
            await flushPendingShiftLogs();
        } catch (error) {
            console.error(
                new Date(),
                "Shift log flush error:",
                error.response && error.response.data
                    ? error.response.data
                    : error.message,
            );
        }
    } catch (error) {
        console.log(error)
        console.error(
            new Date(),
            "Data push error:",
            error.response && error.response.data
                ? error.response.data
                : error.message,
        );

        dataPushDelay = Math.min(dataPushDelay * 2, 60000);

        if (error.code === "ENOTFOUND" || error.code === "ECONNRESET") {
            try {
                axiosInstance.defaults.httpsAgent.destroy();
            } catch (_) {
                // Ignore agent cleanup errors.
            }
        }
    }

    dataPushTimer = setTimeout(dataPushLoop, dataPushDelay);
}

/*
|--------------------------------------------------------------------------
| Express health APIs
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
    const machineHealth = Array.from(readers.values()).map((reader) =>
        reader.getHealth(),
    );

    const connectedMachines = machineHealth.filter((machine) => machine.connected).length;

    res.json({
        ok: true,
        time: new Date(),
        uptimeSeconds: Math.floor(process.uptime()),
        totalMachines: machineHealth.length,
        connectedMachines,
        disconnectedMachines: machineHealth.length - connectedMachines,
        pendingShiftLogs: pendingShiftLogs.length,
        machines: machineHealth,
    });
});

app.get("/health/:machineId", (req, res) => {
    const reader = readers.get(String(req.params.machineId));

    if (!reader) {
        return res.status(404).json({
            ok: false,
            message: "Machine reader not found",
        });
    }

    return res.json({
        ok: true,
        health: reader.getHealth(),
        data: machineData[String(req.params.machineId)] || null,
    });
});

app.get("/machines", (req, res) => {
    res.json({
        ok: true,
        machineData,
    });
});

/*
|--------------------------------------------------------------------------
| Startup validation
|--------------------------------------------------------------------------
*/

function validateConfig() {
    if (!CONFIG.workspaceId) {
        console.warn("WARNING: WORKSPACE_ID is empty");
    }

    if (!CONFIG.apiKey) {
        console.warn("WARNING: API_KEY is empty");
    }
}

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(`Received ${signal}, shutting down...`);

    if (dataPushTimer) {
        clearTimeout(dataPushTimer);

        dataPushTimer = null;
    }

    if (machineSyncTimer) {
        clearInterval(machineSyncTimer);

        machineSyncTimer = null;
    }

    for (const reader of readers.values()) {
        reader.stop();
    }

    readers.clear();

    try {
        axiosInstance.defaults.httpsAgent.destroy();
    } catch (_) {
        // Ignore cleanup error.
    }

    await sleep(300);

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);

    shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

validateConfig();

app.listen(CONFIG.port, async () => {
    console.log(`Haiwell gateway running on http://localhost:${CONFIG.port}`);
    console.log(`API: ${CONFIG.apiBaseUrl}`);
    console.log("Mode: application-level read-only");
    console.log("No SetById or page navigation is used");

    loadPendingShiftLogs();
    if (pendingShiftLogs.length) {
        console.log(`Pending closed shift logs on disk: ${pendingShiftLogs.length}`);
    }

    await initAllMachines();

    dataPushLoop();
});
