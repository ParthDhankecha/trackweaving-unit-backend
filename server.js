"use strict";

const express = require("express");
const axios = require("axios");
const moment = require("moment");
const https = require("https");

const app = express();
app.use(express.json());

const CONFIG = {
    apiBaseUrl: process.env.API_BASE_URL || "https://trackweaving.com/api/v1",
    workspaceId: process.env.WORKSPACE_ID || "6a83fcdd606858cf59de3918",
    apiKey: process.env.API_KEY || "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21",
    port: parseInt(process.env.PORT || "3001", 10),
    /*
     * Single interval reused for both polling the loom's HMI
     * over HTTP and pushing collected data upstream.
     */
    dataPushIntervalMs: parseInt(process.env.DATA_PUSH_INTERVAL_MS || "7000", 10),
    hmiPort: parseInt(process.env.HMI_PORT || "9900", 10),
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

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

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

function textOrNull(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();

    return text || null;
}

/*
 * The HMI reports booleans as the strings "True" / "False".
 */
function apiBool(value) {
    return String(value).trim().toLowerCase() === "true";
}

/*
 * fabricLength / beginLength come back scaled by 1e6
 * (e.g. "13628369" -> 13.62 meters).
 */
function scaledLengthMeters(value) {
    const parsed = numberOrNull(value);

    return parsed === null ? null : Number((parsed / 1000000).toFixed(2));
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
        displayType: machine.displayType || "picanol",
        deviceType: machine.deviceType || "http",
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
        shift: Number.isFinite(Number(existing.shift)) ? Number(existing.shift) : null,
        rawData: existing.rawData || {},
    };

    return machineData[machineId];
}

/*
|--------------------------------------------------------------------------
| Stop classification (rapier loom)
|--------------------------------------------------------------------------
|
| Mapped directly from the stop-type flags exposed by
| .../ProcedureDB/PROCEDURE_FAST_MOTION/MachineStopData/Actual
| Rapier looms have no h1/h2 weft-side split like airjet looms do,
| so stops are bucketed by their actual reported cause instead.
|
*/

/*
 * Each individual stop reason gets its own code (not just its
 * bucket/category) so the exact cause is preserved upstream.
 * Code 0 is reserved to mean "running".
 */
const STOP_FLAG_PRIORITY = [
    ["warpStopType", "warp", 1],
    ["fillingStopType", "weft", 2],
    ["fillingBrakeType", "weft", 3],
    ["bobbinBreakStopType", "feeder", 4],
    ["mechanicalStopType", "other", 5],
    ["emergencyStopType", "manual", 6],
    ["emergencyBrakeType", "manual", 7],
    ["serviceStopType", "other", 8],
    ["otherStopType", "other", 9],
    ["otherBrakeType", "other", 10],
];

const UNKNOWN_STOP_CODE = 11;

function classifyPicanolStop(stopActual) {
    if (stopActual) {
        for (const [flag, category, code] of STOP_FLAG_PRIORITY) {
            if (apiBool(stopActual[flag])) {
                return { category, code };
            }
        }
    }

    return { category: "other", code: UNKNOWN_STOP_CODE };
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
        code: data.stopCode,
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

const ENDPOINTS = {
    production: { path: "/Machine/ModuleManager/ModuleDB/ProductionMonitoring", key: "ProductionMonitoring" },
    shift: { path: "/Machine/ModuleManager/ModuleDB/ProductionMonitoring/currentShift", key: "currentShift" },
    density: { path: "/Machine/pickDensityPerMeter", key: "pickDensityPerMeter" },
    warp: { path: "/Machine/ModuleManager/ModuleDB/EloRight/warpOutPrediction", key: "warpOutPrediction" },
    stopActual: { path: "/Machine/ProcedureManager/ProcedureDB/PROCEDURE_FAST_MOTION/MachineStopData/Actual", key: "Actual" },
};

class PicanolMachineReader {
    constructor(machine) {
        this.machine = machine;
        this.machineId = String(machine.id);
        this.baseUrl = this.createBaseUrl(machine);
        this.pollTimer = null;
        this.polling = false;
        this.destroyed = false;
        this.lastPayloadAt = null;
        this.lastError = null;
    }

    createBaseUrl(machine) {
        if (machine.hmiUrl) {
            return String(machine.hmiUrl).replace(/\/+$/, "");
        }

        if (!machine.ip) {
            throw new Error(`Machine ${machine.id} has no IP address`);
        }

        const ip = String(machine.ip);

        if (ip.startsWith("http://") || ip.startsWith("https://")) {
            return ip.replace(/\/+$/, "");
        }

        const hasPort = /:\d+$/.test(ip);

        return `http://${ip}${hasPort ? "" : `:${CONFIG.hmiPort}`}`;
    }

    start() {
        if (this.destroyed) {
            return;
        }

        initMachineData(this.machine);

        this.poll();

        this.pollTimer = setInterval(() => this.poll(), CONFIG.dataPushIntervalMs);
    }

    async fetchPath({ path, key }) {
        const response = await axiosInstance.get(`${this.baseUrl}${path}`);
        const body = response.data;

        return body && Object.prototype.hasOwnProperty.call(body, key) ? body[key] : body;
    }

    async poll() {
        if (this.destroyed || this.polling) {
            return;
        }

        this.polling = true;

        try {
            const [production, shift, density, warp, stopActual] = await Promise.all([
                this.fetchPath(ENDPOINTS.production),
                this.fetchPath(ENDPOINTS.shift),
                this.fetchPath(ENDPOINTS.density),
                this.fetchPath(ENDPOINTS.warp),
                this.fetchPath(ENDPOINTS.stopActual),
            ]);

            this.lastPayloadAt = new Date().toISOString();
            this.lastError = null;

            if (CONFIG.logVariableChanges) {
                console.log(`[${this.machineId}] production=${JSON.stringify(production)}`);
                console.log(`[${this.machineId}] shift=${JSON.stringify(shift)}`);
                console.log(`[${this.machineId}] stopActual=${JSON.stringify(stopActual)}`);
            }

            this.processMachineData({ production, shift, density, warp, stopActual });
        } catch (error) {
            this.lastError = error.message;

            const state = machineData[this.machineId];

            if (state) {
                state.connected = false;
                state.connectionError = error.message;
            }

            console.error(`[${this.machineId}] Poll error:`, error.message);
        } finally {
            this.polling = false;
        }
    }

    processMachineData({ production, shift, density, warp, stopActual }) {
        const state = machineData[this.machineId] || initMachineData(this.machine);
        const nowUtc = moment().utc().format();

        const running = textOrNull(production && production.currentProductionState) === "RUNNING";
        const stopInfo = running ? null : classifyPicanolStop(stopActual);
        const currentStop = stopInfo ? stopInfo.category : null;
        const currentStopCode = running ? 0 : stopInfo.code;

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

        const currentShiftId = integerOrNull(production && production.currentShiftId);
        const previousShiftId = state.shift;
        const shiftChanged = currentShiftId !== null && previousShiftId !== null && currentShiftId !== previousShiftId;

        if (shiftChanged) {
            console.log(`[${this.machineId}] Shift changed: ${previousShiftId} -> ${currentShiftId}`);

            if (state.stop && currentStop) {
                completeCurrentStop(this.machineId);
                state.lastStopTime = nowUtc;
            }

            state.prevData = clone(state);
            state.stopCount = 0;
            state.stopsData = createEmptyStopsData();

            if (!currentStop) {
                state.lastStartTime = nowUtc;
            }
        }

        state.stop = currentStop;
        state.stopCode = currentStopCode;
        state.stopReasonText = currentStop;
        state.shift = currentShiftId;
        state.updatedTime = nowUtc;
        state.lastDataTime = this.lastPayloadAt;
        state.connected = true;
        state.connectionError = null;
        state.rawData = this.buildRawData({ production, shift, density, warp, currentStop, currentStopCode });
    }

    buildRawData({ production, shift, density, warp, currentStop, currentStopCode }) {
        const efficiency = shift && shift.elapsedTime && shift.timeNormal ? ((shift.timeNormal / shift.elapsedTime) * 100).toFixed(2) : null;
        const runtimeSeconds = numberOrNull(shift && shift.timeNormal);
        const remainingWarpSeconds = numberOrNull(warp && warp.remainingWarpTimePrediction);

        return [
            integerOrNull(production && production.currentShiftId),
            textOrNull(production && production.currentArticleName),
            currentStopCode,
            runtimeSeconds === null ? null : Number((runtimeSeconds / 60).toFixed(2)),
            efficiency === null ? null : Number((efficiency / 10).toFixed(2)),
            numberOrNull(density),
            scaledLengthMeters(shift && shift.fabricLength),
            integerOrNull(shift && shift.pickCounter),
            numberWithTwoDecimalsOrNull(warp && warp.remainingWarpLength),
            numberWithTwoDecimalsOrNull(warp && warp.initialWarpLength),
            remainingWarpSeconds === null
                ? null
                : moment().utc().add(remainingWarpSeconds, "seconds").format(),
            integerOrNull(shift && shift.WarpStopCounter),
            secondsToMinutes(shift && shift.WarpStopTimer),
            integerOrNull(shift && shift.FillingStopCounter),
            secondsToMinutes(shift && shift.FillingStopTimer),
            integerOrNull(shift && shift.BobbinStopCounter),
            secondsToMinutes(shift && shift.BobbinStopTimer),
            integerOrNull(shift && shift.HandStopCounter),
            secondsToMinutes(shift && shift.HandStopTimer),
            integerOrNull(shift && shift.OtherStopCounter),
            secondsToMinutes(shift && shift.OtherStopTimer),
        ];
    }

    getHealth() {
        const state = machineData[this.machineId];

        return {
            machineId: this.machineId,
            ip: this.machine.ip,
            baseUrl: this.baseUrl,
            connected: Boolean(state && state.connected),
            lastPayloadAt: this.lastPayloadAt,
            lastError: this.lastError,
            connectionError: state ? state.connectionError : null,
        };
    }

    updateMachine(machine) {
        this.machine = machine;

        const newBaseUrl = this.createBaseUrl(machine);

        /*
         * Reconnect only when the HMI address changed.
         */
        if (newBaseUrl !== this.baseUrl) {
            console.log(`[${this.machineId}] HMI address changed from ${this.baseUrl} to ${newBaseUrl}`);

            this.stop();

            this.destroyed = false;
            this.baseUrl = newBaseUrl;

            this.start();
        }
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

function isPicanolMachine(machine) {
    const displayType = String(machine.displayType || "").toLowerCase();

    return displayType === "picanol";
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

    const picanolMachines = machines.filter(isPicanolMachine);

    const activeMachineIds = new Set(
        picanolMachines.map((machine) => String(machine.id)),
    );

    /*
     * Add or update readers.
     */
    for (const machine of picanolMachines) {
        const machineId = String(machine.id);
        initMachineData(machine);
        const existingReader = readers.get(machineId);
        if (existingReader) {
            existingReader.updateMachine(machine);

            continue;
        }
        try {
            const reader = new PicanolMachineReader(machine);
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

    console.log(`Picanol machines active: ${readers.size}`);
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
    console.log(`Picanol gateway running on http://localhost:${CONFIG.port}`);
    console.log(`API: ${CONFIG.apiBaseUrl}`);
    console.log("Mode: HTTP polling, read-only");

    await initAllMachines();

    dataPushLoop();
});
