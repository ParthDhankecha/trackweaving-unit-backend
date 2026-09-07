"use strict";

const express = require("express");
const axios = require("axios");
const moment = require("moment");
const https = require("https");
const { readItemaMachine } = require("./itema");

const app = express();
app.use(express.json());

const CONFIG = {
    apiBaseUrl: process.env.API_BASE_URL || "https://trackweaving.com/api/v1",
    workspaceId: process.env.WORKSPACE_ID || "6a900dd650559fa74a9eeea5",
    apiKey: process.env.API_KEY || "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21",
    port: parseInt(process.env.PORT || "3001", 10),
    /*
     * Single interval reused for both polling the loom over TCP
     * and pushing collected data upstream.
     */
    dataPushIntervalMs: parseInt(process.env.DATA_PUSH_INTERVAL_MS || "7000", 10),
    logVariableChanges: process.env.LOG_VARIABLE_CHANGES === "true",
};
    
const axiosInstance = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({
        keepAlive: false,
        maxSockets: 10,
    }),
});

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

let machineData = {};

const readers = new Map();

let shuttingDown = false;
let dataPushTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
|--------------------------------------------------------------------------
| Value helpers
|--------------------------------------------------------------------------
*/

function numberOrNull(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
}

function numberWithTwoDecimalsOrNull(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Number(parsed.toFixed(2));
}

function integerOrNull(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Math.trunc(parsed);
}

function secondsToMinutes(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Number((parsed / 60).toFixed(2));
}

/*
|--------------------------------------------------------------------------
| Machine data initialization
|--------------------------------------------------------------------------
*/

function createEmptyStopsData() {
    return {
        warp: [],
        weft: [],
        feeder: [],
        manual: [],
        other: [],
    };
}

function initMachineData(machine) {
    const machineId = String(machine.id);

    const existing = machineData[machineId] || {};

    machineData[machineId] = {
        ...existing,
        displayType: machine.displayType || "itema",
        deviceType: machine.deviceType || "tcp",
        ip: machine.ip,
        connected: false,
        connectionError: null,
        updatedTime: existing.updatedTime || null,
        lastDataTime: existing.lastDataTime || null,
        stopCount: existing.stopCount || 0,
        stopsData: existing.stopsData || createEmptyStopsData(),
        lastStopTime: existing.lastStopTime || null,
        lastStartTime: existing.lastStartTime || null,
        stop: existing.stop || null,
        stopReasonText: existing.stopReasonText || null,
        rawData: existing.rawData || {},
    };

    return machineData[machineId];
}

function completeCurrentStop(machineId) {
    const data = machineData[machineId];

    if (!data || !data.lastStopTime || !data.stop) {
        return;
    }

    const now = moment().utc();
    const stopStart = moment(data.lastStopTime);
    const duration = Math.max(0, now.diff(stopStart, "seconds"));
    const category = data.stop;
    const entry = {
        start: data.lastStopTime,
        end: now.format(),
        category,
        statusCode: data.stopCode,
        duration,
    };

    /*
     * Same rule as the existing program:
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
| Itema machine reader (TCP, IDT protocol)
|--------------------------------------------------------------------------
|
| Live stop category codes (IDT 5, buf[2]) are mapped to their
| human-readable reason and their warp/weft/feeder/manual/other
| bucket below. Shift-cumulative per-category counters (IDT 200)
| are unaffected by this and are reported as-is.
|
*/

const STOP_REASON = {
    0: "--",
    1: "Warp stop",
    4: "Production end",
    5: "Manual stop",
    6: "Technical stop",
    7: "Cone end stop",
    10: "Weft anomaly",
    11: "No gripping",
    12: "Left gripper",
    13: "No exchange",
    14: "Right gripper",
    15: "Leno stop",
    16: "Waste selvedge stop",
};

/*
 * Buckets each live stop code into the same warp/weft/feeder/manual/other
 * categories used by the shift-cumulative counters (IDT 200) in itema.js.
 * Codes not listed here (e.g. production end, technical stop) fall back
 * to "other".
 */
const STOP_CATEGORY_BY_CODE = {
    1: "warp",
    5: "manual",
    7: "feeder",
    10: "weft",
    11: "weft",
    12: "weft",
    13: "weft",
    14: "weft",
    15: "weft",
    16: "weft",
};

function classifyItemaStop(stopCategory) {
    return STOP_CATEGORY_BY_CODE[stopCategory] || "other";
}

class ItemaMachineReader {
    constructor(machine) {
        this.machine = machine;
        this.machineId = String(machine.id);
        this.ip = machine.ip;
        this.port = machine.port || undefined;
        this.pollTimer = null;
        this.polling = false;
        this.destroyed = false;
        this.lastPayloadAt = null;
        this.lastError = null;
    }

    start() {
        if (this.destroyed) return;

        initMachineData(this.machine);

        const startupDelay = Math.floor(
            Math.random() * CONFIG.dataPushIntervalMs
        );

        this.pollTimer = setTimeout(
            () => this.poll(),
            startupDelay
        );
    }

    async poll() {
        if (this.destroyed || this.polling) return;

        this.polling = true;

        try {
            const data = await readItemaMachine(
                this.ip,
                this.port
            );

            this.lastPayloadAt = new Date().toISOString();
            this.lastError = null;

            if (CONFIG.logVariableChanges) {
                console.log(
                    `[${this.machineId}] itema=${JSON.stringify(data)}`
                );
            }

            this.processMachineData(data);

        } catch (error) {
            this.lastError = error.message;

            const state = machineData[this.machineId];

            if (state) {
                state.connected = false;
                state.connectionError = error.message;
            }

            console.error(
                `[${this.machineId}] Poll error:`,
                error.message
            );

        } finally {
            this.polling = false;

            if (!this.destroyed) {
                this.pollTimer = setTimeout(
                    () => this.poll(),
                    CONFIG.dataPushIntervalMs
                );
            }
        }
    }

    processMachineData(data) {
        const state = machineData[this.machineId] || initMachineData(this.machine);
        const nowUtc = moment().utc().format();

        const running = (data.stopCategory ?? 0) === 0;
        const currentStop = running ? null : classifyItemaStop(data.stopCategory);
        const currentStopCode = running ? 0 : data.stopCategory * 1000 + (data.stopDetail || 0);

        if (!state.stop && currentStop) {
            state.lastStopTime = nowUtc;
        }
        if (state.stop && !currentStop) {
            state.lastStartTime = nowUtc;
            completeCurrentStop(this.machineId);
            state.lastStopTime = null;
        }
        if (state.stop && currentStop && state.stop !== currentStop) {
            completeCurrentStop(this.machineId);
            state.lastStopTime = nowUtc;
        }

        state.stop = currentStop;
        state.stopCode = currentStopCode;
        state.stopReasonText = currentStop;
        state.updatedTime = nowUtc;
        state.lastDataTime = this.lastPayloadAt;
        state.connected = true;
        state.connectionError = null;
        state.rawData = this.buildRawData(data, currentStopCode);
    }

    buildRawData(data, currentStopCode) {
        const runtimeSeconds = numberOrNull(data.runtime);

        return [
            data.currentShiftId,
            currentStopCode,
            runtimeSeconds === null ? null : Number((runtimeSeconds / 60).toFixed(2)),
            numberOrNull(data.efficiency),
            numberOrNull(data.weftDensity),
            numberWithTwoDecimalsOrNull(data.productionMtr),
            integerOrNull(data.picksCurrentShift),
            integerOrNull(data.warp && data.warp.count),
            secondsToMinutes(data.warp && data.warp.duration),
            integerOrNull(data.weft && data.weft.count),
            secondsToMinutes(data.weft && data.weft.duration),
            integerOrNull(data.feeder && data.feeder.count),
            secondsToMinutes(data.feeder && data.feeder.duration),
            integerOrNull(data.manual && data.manual.count),
            secondsToMinutes(data.manual && data.manual.duration),
            integerOrNull(data.other && data.other.count),
            secondsToMinutes(data.other && data.other.duration),
            integerOrNull(data.speed),
        ];
    }

    getHealth() {
        const state = machineData[this.machineId];

        return {
            machineId: this.machineId,
            ip: this.ip,
            port: this.port || null,
            connected: Boolean(state && state.connected),
            lastPayloadAt: this.lastPayloadAt,
            lastError: this.lastError,
            connectionError: state ? state.connectionError : null,
        };
    }

    updateMachine(machine) {
        this.machine = machine;
        this.ip = machine.ip;
        this.port = machine.port || undefined;
    }

    stop() {
        this.destroyed = true;

        if (this.pollTimer) {
            clearInterval(this.pollTimer);

            this.pollTimer = null;
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

function isItemaMachine(machine) {
    const displayType = String(machine.displayType || "").toLowerCase();

    return displayType === "itema";
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

    const itemaMachines = machines.filter(isItemaMachine);

    const activeMachineIds = new Set(
        itemaMachines.map((machine) => String(machine.id)),
    );

    /*
     * Add or update readers.
     */
    for (const machine of itemaMachines) {
        const machineId = String(machine.id);
        initMachineData(machine);
        const existingReader = readers.get(machineId);
        if (existingReader) {
            existingReader.updateMachine(machine);

            continue;
        }
        try {
            const reader = new ItemaMachineReader(machine);
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

    console.log(`Itema machines active: ${readers.size}`);
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

        /*
         * Clear prevData only after a successful upload.
         */
        for (const machineId of Object.keys(machineData)) {
            if (machineData[machineId].prevData) {
                machineData[machineId].prevData = null;
            }
        }

        dataPushDelay = CONFIG.dataPushIntervalMs;
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

function validateConfig() {
    if (!CONFIG.workspaceId) {
        console.warn("WARNING: WORKSPACE_ID is empty");
    }

    if (!CONFIG.apiKey) {
        console.warn("WARNING: API_KEY is empty");
    }
}

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
    console.log(`Itema gateway running on http://localhost:${CONFIG.port}`);
    console.log(`API: ${CONFIG.apiBaseUrl}`);
    console.log("Mode: TCP polling, read-only");

    await initAllMachines();

    dataPushLoop();
});
