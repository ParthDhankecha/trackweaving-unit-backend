// server.js / index.js
const express = require("express");
const axios = require("axios");
const ModbusRTU = require("modbus-serial");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const https = require("https");
const axiosInstance = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({
        keepAlive: false,
    }),
});

const app = express();

// ====== CONFIG ======
const LOOM_PORT = parseInt(process.env.LOOM_PORT || "502", 10);
const START_ADDR = parseInt(process.env.START_ADDR || "1", 10);
const COUNT = parseInt(process.env.COUNT || "102", 10);
const ZERO_BASED = true;
const READ_TIMEOUT_MS = parseInt(process.env.READ_TIMEOUT_MS || "7000", 10);
const MAX_REGS_PER_READ = parseInt(process.env.MAX_REGS_PER_READ || "60", 10);

const workspaceId = "6a47941530e89397e63fa219";
const apiKey = "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21";
const API_BASE_URL = process.env.API_BASE_URL || "https://trackweaving.com/api/v1";
const PENDING_SHIFT_LOGS_PATH = process.env.PENDING_SHIFT_LOGS_PATH || path.join(process.cwd(), "pending-shift-logs.json");

const REGISTER = {
    nazon: {
        stop: 5027,
        shift: 5012,
        setPicks: 5035,
        clothLength: 5018,
        loomState: 5028,
        speed: 5010,
        efficiency: 5017
    },
    chitic: {
        stop: 5023,
        shift: 5005,
        setPicks: 5002,
        clothLength: 5006,
        loomState: 5013,
        speed: 5003,
        efficiency: 5044
    },
    pickwell: {
        stop: 5023,
        shift: 5005,
        setPicks: 5002,
        clothLength: 5006,
        loomState: 5013,
        speed: 5003,
        efficiency: 5044
    },
    biana: {
        stop: 6,
        shift: 1,
        speed: 2,
        nightSpeed: 72
    }
};

const UNIT_IDS = {
    'nazon': 85,
    'chitic': 1,
    'pickwell': 1,
    'biana': 255
}

let machineData = {};
let isDataStorAPICalled = false;
let pendingShiftLogs = [];

// Track all active clients for graceful shutdown
const allClients = new Set();

// ====== HELPERS ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initMachineData(machineId, displayType) {
    machineData[machineId] = {
        displayType,
        stopCount: 0,
        stopsData: {
            warp: [],
            weft: [],
            feeder: [],
            manual: [],
            other: [],
            h1: [],
            h2: []
        },
        lastStopTime: null,
        lastStartTime: null,
        stop: 0
    };
}

function ensureStopsDataShape(entry) {
    const defaults = { warp: [], weft: [], feeder: [], manual: [], other: [], h1: [], h2: [] };
    if (!entry.stopsData || typeof entry.stopsData !== "object") {
        entry.stopsData = {};
    }
    for (const key of Object.keys(defaults)) {
        if (!Array.isArray(entry.stopsData[key])) {
            entry.stopsData[key] = [];
        }
    }
}

function loadPendingShiftLogs() {
    try {
        if (!fs.existsSync(PENDING_SHIFT_LOGS_PATH)) {
            pendingShiftLogs = [];
            return;
        }

        const parsed = JSON.parse(fs.readFileSync(PENDING_SHIFT_LOGS_PATH, "utf8"));
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
    const tmpPath = `${PENDING_SHIFT_LOGS_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ logs: pendingShiftLogs }, null, 2));
    fs.renameSync(tmpPath, PENDING_SHIFT_LOGS_PATH);
}

function enqueueClosedShiftLog(machineId, state, endedAt) {
    pendingShiftLogs.push({
        id: `${machineId}-${Date.now()}-${state.shift ?? "x"}`,
        machineId,
        updatedTime: endedAt,
        lastStopTime: state.lastStopTime || null,
        lastStartTime: state.lastStartTime || null,
        stop: state.stop,
        stopsData: JSON.parse(JSON.stringify(state.stopsData || {})),
        rawData: JSON.parse(JSON.stringify(state.rawData || [])),
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

    await axiosInstance.post(`${API_BASE_URL}/machine-logs/shift`, {
        logs: toFlush,
        workspaceId,
        apiKey,
    });

    removePendingShiftLogs(toFlush.map((log) => log.id));
    console.log(`Flushed ${toFlush.length} closed shift log(s)`);
}

function setStopData(machineId, displayType) {
    let stopDuration = 0;

    ensureStopsDataShape(machineData[machineId]);

    if (machineData[machineId].lastStopTime) {
        const stopTime = moment(machineData[machineId].lastStopTime);
        stopDuration = Math.abs(moment().diff(stopTime, "seconds"));
        if (stopDuration >= 60) {
            machineData[machineId].stopCount += 1;
        }
    }

    const stopCode = machineData[machineId].stop;
    const baseEntry = {
        start: machineData[machineId].lastStopTime,
        end: moment().utc().format(),
        statusCode: stopCode,
        duration: stopDuration
    };

    // Logic split by displayType
    if (displayType === "nazon") {
        switch (stopCode) {
            case 1:
            case 19:
            case 20:
                machineData[machineId].stopsData.warp.push(baseEntry);
                break;
            case 2:
            case 3:
            case 11:
            case 12:
            case 15:
            case 16:
            case 17:
            case 18:
                machineData[machineId].stopsData.weft.push(baseEntry);
                break;
            case 7:
                machineData[machineId].stopsData.feeder.push(baseEntry);
                break;
            case 4:
            case 6:
                machineData[machineId].stopsData.manual.push(baseEntry);
                break;
            default:
                machineData[machineId].stopsData.other.push(baseEntry);
                break;
        }
    } else if (["chitic", "pickwell"].includes(displayType)) {
        switch (stopCode) {
            case 1:
                machineData[machineId].stopsData.warp.push(baseEntry);
                break;
            case 2:
            case 3:
            case 11:
            case 12:
                machineData[machineId].stopsData.weft.push(baseEntry);
                break;
            case 7:
                machineData[machineId].stopsData.feeder.push(baseEntry);
                break;
            case 4:
            case 6:
                machineData[machineId].stopsData.manual.push(baseEntry);
                break;
            default:
                machineData[machineId].stopsData.other.push(baseEntry);
                break;
        }
    } else if(displayType === "biana") {
        switch (stopCode) {
            case 1:
                machineData[machineId].stopsData.manual.push(baseEntry);
                break;

            case 2:
                machineData[machineId].stopsData.warp.push(baseEntry);
                break;
            
            case 3:
            case 4:
            case 5:
            case 6:
            case 7:
            case 8:
            case 9:
                machineData[machineId].stopsData.h1.push(baseEntry);
                break;
                
            default:
                machineData[machineId].stopsData.other.push(baseEntry);
                break;

        }
    }
}

function processData(machine, data) {
    const machineId = machine.id;
    const displayType = machine.displayType || "nazon";
    const reg = REGISTER[displayType];

    if (!reg) {
        console.warn(`Unknown displayType "${displayType}" for machine ${machineId}`);
        return;
    }

    const startAddr = ZERO_BASED ? START_ADDR - 1 : START_ADDR;
    const at = (addr) => data[addr - startAddr];

    let speed = at(reg.speed);
    let stop = at(reg.stop);
    let shift = at(reg.shift);
    if(at(reg.nightSpeed) > 10){
        shift = 1;
    }

    // if (speed > 20) {
    //     data[reg.stop - startAddr] = 0;
    //     stop = 0;
    // }

    if (!machineData[machineId]) {
        initMachineData(machineId, displayType);
    }
    machineData[machineId].updatedTime = moment().utc().format();

    // Handle transitions between running and stopped
    if (machineData[machineId].stop === 0 && stop !== 0) {
        // just stopped
        machineData[machineId].lastStopTime = moment().utc().format();
    } else if (machineData[machineId].stop !== 0 && stop === 0) {
        // just started
        machineData[machineId].lastStartTime = moment().utc().format();
        setStopData(machineId, displayType);
    } else if (
        typeof machineData[machineId].shift === "number" &&
        shift !== machineData[machineId].shift
    ) {
        // shift change
        if (machineData[machineId].stop !== 0 && stop !== 0) {
            setStopData(machineId, displayType);
            machineData[machineId].lastStopTime = moment().utc().format();
        }

        enqueueClosedShiftLog(
            machineId,
            JSON.parse(JSON.stringify(machineData[machineId])),
            moment().utc().format(),
        );
        machineData[machineId].stopCount = 0;
        machineData[machineId].stopsData = {
            warp: [],
            weft: [],
            feeder: [],
            manual: [],
            other: [],
            h1: [],
            h2: []
        };

        if (machineData[machineId].stop === 0 && stop === 0) {
            machineData[machineId].lastStartTime = moment().utc().format();
        }
    }

    machineData[machineId].stop = stop;

    // Adjust setPicks and efficiency for some device types
    if (machine.deviceType === "rs485" || ["chitic", "pickwell"].includes(displayType)) {
        data[reg.setPicks - startAddr] = at(reg.setPicks) / 10;
    }
    if (["chitic", "pickwell"].includes(displayType)) {
        data[reg.efficiency - startAddr] = at(reg.efficiency);
    }

    if(displayType === "biana" && shift == 1) {
        data[0] = 1;
    }

    machineData[machineId].rawData = data;
    machineData[machineId].shift = shift;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout`)), ms)
        )
    ]);
}

// Read `count` registers starting at `start` in chunks sized by `MAX_REGS_PER_READ`.
// Returns an object with a `data` array compatible with `modbus-serial` responses.
async function readRegistersInChunks(client, start, count, ip) {
    const chunks = [];
    let remaining = count;
    let offset = start;

    while (remaining > 0) {
        const len = Math.min(remaining, MAX_REGS_PER_READ);
        const part = await withTimeout(
            client.readHoldingRegisters(offset, len),
            READ_TIMEOUT_MS,
            `Read timeout ${ip}`
        );
        const dataPart = part.data || [];
        chunks.push(...dataPart);
        offset += len;
        remaining -= len;
        // small pause between chunked requests to avoid overwhelming the device
        await sleep(50);
    }

    return { data: chunks };
}

// ====== POLLING LOOP (per machine) ======
async function pollLoop(machine) {
    const client = new ModbusRTU();
    allClients.add(client);

    const displayType = machine.displayType || "nazon";
    let unitId = UNIT_IDS[displayType] || 1;

    let backoffMs = 5000;
    let lastError = null;
    let connecting = false;
    let consecutiveTimeouts = 0;

    const ip = machine.ip;

    // Event handlers to avoid unhandled errors
    client.on("error", (e) => {
        lastError = e?.message || String(e);
        console.log(`Client error on ${ip}:`, lastError);
        try {
            if (client.isOpen) client.close(true);
        } catch (_) {}
    });

    client.on("close", () => {
        console.log(`Connection closed for ${ip}`);
    });

    async function connect() {
        if (client.isOpen || connecting) return;
        connecting = true;
        try {
            console.log(`Connecting to ${ip}:${LOOM_PORT} (UNIT_ID=${unitId})...`);
            await client.connectTCP(ip, { port: LOOM_PORT });
            client.setID(unitId);
            // IMPORTANT: do NOT set client.setTimeout here; the library
            // sometimes throws uncaught on its own TCP timeout.
            console.log(`Connected to ${ip}:${LOOM_PORT} (UNIT_ID=${unitId})`);
            lastError = null;
            connecting = false;
        } catch (e) {
            connecting = false;
            lastError = e?.message || String(e);
            console.log(`Connect error for ${ip}:`, lastError);
            try {
                if (client.isOpen) client.close(true);
            } catch (_) {}
        } finally {
            connecting = false;
        }
    }

    const start = ZERO_BASED ? START_ADDR - 1 : START_ADDR;

    while (true) {
        try {
            if (!client.isOpen && !connecting) {
                await connect();
            }

            if (client.isOpen) {
                let resp;
                try {
                    // Use chunked reads when COUNT exceeds MAX_REGS_PER_READ or for biana devices
                    if (displayType === "biana" || COUNT > MAX_REGS_PER_READ) {
                        resp = await readRegistersInChunks(client, start, COUNT, ip);
                    } else {
                        resp = await withTimeout(
                            client.readHoldingRegisters(start, COUNT),
                            READ_TIMEOUT_MS,
                            `Read timeout ${ip}`
                        );
                    }
                } catch (e) {
                    lastError = e?.message || String(e);
                    console.log(`Read error for ${ip}:`, lastError);

                    if (lastError.includes("Read timeout")) {
                        consecutiveTimeouts += 1;
                    } else {
                        consecutiveTimeouts = 0;
                    }

                    if (lastError.includes("Read timeout") || consecutiveTimeouts > 0) {
                        try {
                            if (client.isOpen) client.close(true);
                        } catch (_) {
                            try { client.close(); } catch (_) {}
                        }
                    } else {
                        try {
                            client.close(true);
                        } catch (_) {
                            try { client.close(); } catch (_) {}
                        }
                    }

                    // increase backoff
                    backoffMs = Math.min(backoffMs * 2, 10000);
                    await sleep(backoffMs);
                    continue;
                }

                const data = resp.data || [];

                const reg = REGISTER[displayType];
                if (
                    displayType !== "biana" &&
                    data.length > 30 &&
                    data[reg.clothLength - start] === 0 &&
                    data[reg.loomState - start] === 0 &&
                    data[reg.speed - start] === 0
                ) {
                    console.log(`Suspicious zero data from ${ip}:`, data);
                } else {
                    processData(machine, data);
                }

                lastError = null;
                consecutiveTimeouts = 0;
                backoffMs = 1000; // reset backoff on success
            }
        } catch (err) {
            const msg = err?.message || String(err);
            console.log(`Unexpected error in pollLoop(${ip}):`, msg);
            lastError = msg;
            try {
                client.close(true);
            } catch (_) {
                try { client.close(); } catch (_) {}
            }
            backoffMs = Math.min(backoffMs * 2, 10000);
        }

        await sleep(backoffMs);
    }
}

// ====== INIT ALL MACHINES ======
async function initAllMachines() {
    let delayMs = 5000;

    while(true) {
        try {
            console.log("Fetching machine list...");
            let initData = await axiosInstance.post(
                `${API_BASE_URL}/machine-logs/machine-list`,
                {
                    workspaceId,
                    apiKey
                }
            );
            initData = initData.data;

            // preload machineData if backend sends something
            machineData = initData.data.machineData || {};
            for (const machineId in machineData) {
                ensureStopsDataShape(machineData[machineId]);
            }

            for (let machine of initData.data.machines) {
                // fire and forget, each has its own loop and connection
                pollLoop(machine).catch((e) => {
                    console.error(`pollLoop crashed for machine ${machine.id}:`, e);
                });
            }
            console.log(`Initialized ${initData.data.machines.length} machines.`);
            return;
        } catch (error) {
            console.log("Error fetching machine list:", error?.message || error);
            console.log(`Retrying in ${delayMs / 1000} seconds...`);
            await sleep(delayMs);
            delayMs = Math.min(delayMs * 2, 60000); // exponential backoff up to 1 min
        }
    }
}

// ====== PERIODIC DATA PUSH ======
let dataPushDelay = 5000;

async function dataPushLoop() {
    try {
        const dataToSend = {};
        for (let machineId in machineData) {
            const m = machineData[machineId];
            if (
                m.updatedTime &&
                moment().diff(moment(m.updatedTime), "hours") < 1
            ) {
                dataToSend[machineId] = { ...m };
                delete dataToSend[machineId].prevData;
            }
        }
        await axiosInstance.post(`${API_BASE_URL}/machine-logs`, {
            logs: dataToSend,
            workspaceId,
            apiKey
        });

        dataPushDelay = 5000; // reset delay on success

        try {
            await flushPendingShiftLogs();
        } catch (error) {
            console.log(new Date(), "Shift log flush error:", error?.message || error);
        }
    } catch (error) {
        console.log(new Date(), "Error in data store interval:", error?.message || error);
        dataPushDelay = Math.min(dataPushDelay * 2, 60000); // exponential backoff up to 1 min
        if (error.code === "ENOTFOUND" || error.code === "ECONNRESET") {
            axiosInstance.defaults.httpsAgent.destroy();
        }
    }

    setTimeout(dataPushLoop, dataPushDelay);
}

loadPendingShiftLogs();
if (pendingShiftLogs.length) {
    console.log(`Pending closed shift logs on disk: ${pendingShiftLogs.length}`);
}
dataPushLoop();

// ====== EXPRESS SERVER ======
const PORT = parseInt(process.env.PORT || "3001", 10);

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        time: new Date(),
        machines: Object.keys(machineData).length,
        pendingShiftLogs: pendingShiftLogs.length,
    });
});

app.listen(PORT, () => {
    console.log(
        `Loom server on http://localhost:${PORT} started At ${new Date()}`
    );
    console.log(
        `Polling start=${START_ADDR} count=${COUNT} zeroBased=${ZERO_BASED}`
    );
    initAllMachines().catch((e) => {
        console.error("Failed to init machines:", e);
    });
});

// ====== GLOBAL ERROR SAFETY NET ======

// Specifically swallow the "TCP Connection Timed Out" crash coming from modbus-serial
process.on("uncaughtException", (err) => {
    if (
        err &&
        err.message &&
        (
            err.message.includes("TCP Connection Timed Out") ||
            err.message.includes("self.callback is not a function")
        )
    ) {
        console.error("Ignored uncaught TCP timeout error:", err.message);
        return;
    }
    console.error("Uncaught exception, exiting:", err);
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});

// graceful shutdown
process.on("SIGINT", async () => {
    console.log("Gracefully shutting down...");
    for (const client of allClients) {
        try {
            if (client.isOpen) client.close(true);
        } catch (_) {}
    }
    process.exit(0);
});
