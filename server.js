// server.js / index.js
const express = require("express");
const axios = require("axios");
const ModbusRTU = require("modbus-serial");
const moment = require("moment");
const fs = require("fs");
const path = require("path");

const app = express();

// ====== CONFIG ======
const LOOM_PORT = parseInt(process.env.LOOM_PORT || "502", 10);
const START_ADDR = parseInt(process.env.START_ADDR || "5000", 10);
const COUNT = parseInt(process.env.COUNT || "74", 10);
const ZERO_BASED = true;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "7000", 10);
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || "15000", 10);

const workspaceId = "6aae2913246baf82dce97b83";
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
    }
};

let machineData = {};
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
            other: []
        },
        lastStopTime: null,
        lastStartTime: null,
        stop: 0
    };
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

    await axios.post(`${API_BASE_URL}/machine-logs/shift`, {
        logs: toFlush,
        workspaceId,
        apiKey,
    }, { timeout: API_TIMEOUT_MS });

    removePendingShiftLogs(toFlush.map((log) => log.id));
    console.log(`Flushed ${toFlush.length} closed shift log(s)`);
}

function setStopData(machineId, displayType) {
    let stopDuration = 0;

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
    } else if (displayType === "chitic") {
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

    // Special handling for chitic displays
    if (displayType === "chitic") {
        if (speed > 5) {
            data[reg.stop - startAddr] = 0;
            stop = 0;
        }
    }

    if (!machineData[machineId]) {
        initMachineData(machineId, displayType);
    }

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
        at(reg.shift) !== machineData[machineId].shift
    ) {
        // shift change
        if (machineData[machineId].stop !== 0 && stop !== 0) {
            setStopData(machineId, displayType);
            machineData[machineId].lastStopTime = moment().utc().format();
        }

        enqueueClosedShiftLog(
            machineId,
            machineData[machineId],
            moment().utc().format(),
        );
        machineData[machineId].stopCount = 0;
        machineData[machineId].stopsData = {
            warp: [],
            weft: [],
            feeder: [],
            manual: [],
            other: []
        };

        if (machineData[machineId].stop === 0 && stop === 0) {
            machineData[machineId].lastStartTime = moment().utc().format();
        }
    }

    machineData[machineId].stop = stop;

    // Adjust setPicks and efficiency for some device types
    if (machine.deviceType === "rs485" || displayType === "chitic") {
        data[reg.setPicks - startAddr] = at(reg.setPicks) / 10;
    }
    if (displayType === "chitic") {
        data[reg.efficiency - startAddr] = at(reg.efficiency) * 10;
    }

    machineData[machineId].rawData = data;
    machineData[machineId].shift = at(reg.shift);
    machineData[machineId].updatedTime = moment().utc().format();
}

// ====== POLLING LOOP (per machine) ======
async function pollLoop(machine) {
    const client = new ModbusRTU();
    allClients.add(client);

    const displayType = machine.displayType || "nazon";
    const unitId = displayType === "chitic" ? 1 : 85;

    let backoffMs = POLL_INTERVAL_MS;
    let lastError = null;
    let connecting = false;

    const ip = machine.ip;

    // Event handlers to avoid unhandled errors
    client.on("error", (e) => {
        lastError = e?.message || String(e);
        console.log(`Client error on ${ip}:`, lastError);
        try {
            if (client.isOpen) client.close();
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
        } catch (e) {
            lastError = e?.message || String(e);
            console.log(`Connect error for ${ip}:`, lastError);
            try {
                if (client.isOpen) client.close();
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
                    resp = await client.readHoldingRegisters(start, COUNT);
                } catch (e) {
                    lastError = e?.message || String(e);
                    console.log(`Read error for ${ip}:`, lastError);
                    try {
                        if (client.isOpen) client.close();
                    } catch (_) {}
                    // increase backoff
                    backoffMs = Math.min(backoffMs * 2, 10000);
                    await sleep(backoffMs);
                    continue;
                }

                const data = resp.data || [];

                const reg = REGISTER[displayType];
                if (
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
                backoffMs = POLL_INTERVAL_MS;
            }
        } catch (err) {
            const msg = err?.message || String(err);
            console.log(`Unexpected error in pollLoop(${ip}):`, msg);
            lastError = msg;
            try {
                if (client.isOpen) client.close();
            } catch (_) {}
            backoffMs = Math.min(backoffMs * 2, 10000);
        }

        await sleep(backoffMs);
    }
}

// ====== INIT ALL MACHINES ======
async function initAllMachines() {
    let initData = await axios.post(
        `${API_BASE_URL}/machine-logs/machine-list`,
        {
            workspaceId,
            apiKey
        },
        { timeout: API_TIMEOUT_MS }
    );

    initData = initData.data;

    // preload machineData if backend sends something
    machineData = initData.data.machineData || {};

    for (let machine of initData.data.machines) {
        // fire and forget, each has its own loop and connection
        pollLoop(machine).catch((e) => {
            console.error(`pollLoop crashed for machine ${machine.id}:`, e);
        });
    }
}

// ====== PERIODIC DATA PUSH ======
async function dataStoreLoop() {
    while (true) {
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

            await axios.post(`${API_BASE_URL}/machine-logs`, {
                logs: dataToSend,
                workspaceId,
                apiKey
            }, { timeout: API_TIMEOUT_MS });

            try {
                await flushPendingShiftLogs();
            } catch (error) {
                console.log("Shift log flush error:", error.message || error);
            }
        } catch (error) {
            console.log("Error in data store interval:", error.message || error);
        }

        await sleep(5000);
    }
}

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
    loadPendingShiftLogs();
    if (pendingShiftLogs.length) {
        console.log(`Pending closed shift logs on disk: ${pendingShiftLogs.length}`);
    }
    dataStoreLoop().catch((e) => {
        console.error("dataStoreLoop crashed:", e);
    });
    initAllMachines().catch((e) => {
        console.error("Failed to init machines:", e);
    });
});

// ====== GLOBAL ERROR SAFETY NET ======

// Specifically swallow the "TCP Connection Timed Out" crash coming from modbus-serial
process.on("uncaughtException", (err) => {
    if (err && err.message && err.message.includes("TCP Connection Timed Out")) {
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
            if (client.isOpen) client.close();
        } catch (_) {}
    }
    process.exit(0);
});
