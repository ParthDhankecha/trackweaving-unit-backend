"use strict";

const express = require("express");
const axios = require("axios");
const https = require("https");
const { Writable } = require("stream");
const ftp = require("basic-ftp");
const moment = require("moment");
const fs = require("fs");
const path = require("path");

const app = express();

// ====== CONFIG ======
const API_BASE_URL = process.env.TRACKWEAVING_API_URL || "https://trackweaving.com/api/v1";
const WORKSPACE_ID = process.env.WORKSPACE_ID || "6a993394e0b2517b5fa0e3d2";
const API_KEY = process.env.TRACKWEAVING_API_KEY || "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21";

// --- Direct-to-loom FTP (status only, fast) ---
const FTP_PORT = toInteger(process.env.FTP_PORT, 21);
const FTP_USERNAME = process.env.FTP_USERNAME || "anonymous";
const FTP_PASSWORD = process.env.FTP_PASSWORD || "aaatccs@";
const FTP_SECURE = /^true$/i.test(process.env.FTP_SECURE || "false");
const FTP_TIMEOUT_MS = toInteger(process.env.FTP_TIMEOUT_MS, 7000);
const FTP_FILE_RETRY_COUNT = toInteger(process.env.FTP_FILE_RETRY_COUNT, 2);
const FTP_FILE_RETRY_DELAY_MS = toInteger(process.env.FTP_FILE_RETRY_DELAY_MS, 250);

// This is the interval per loom. Kept well under TLM's own ~10-16 min cadence
// (so stops are caught in time for a 2.5 min highlight) but nowhere near the
// old 5s/16-concurrent setup that collided with TLM's own polling.
const STATUS_POLL_INTERVAL_MS = toInteger(process.env.STATUS_POLL_INTERVAL_MS, 100000);
const MAX_CONCURRENT_FTP = toInteger(process.env.MAX_CONCURRENT_FTP, 8);
const MAX_FAILURE_BACKOFF_MS = toInteger(process.env.MAX_FAILURE_BACKOFF_MS, 15000);

// --- TLM main-computer FTP export (slow, production/report data) ---
// This is TLMServer.exe on the TLM main PC, serving C:\TSUDA (alias TSUDA per FTP.INI).
const TLM_SERVER_HOST = process.env.TLM_SERVER_HOST || "172.21.0.1";
const TLM_SERVER_PORT = toInteger(process.env.TLM_SERVER_PORT, 21);
const TLM_SERVER_USER = process.env.TLM_SERVER_USER || "anonymous";
const TLM_SERVER_PASSWORD = process.env.TLM_SERVER_PASSWORD || "tccs@";
const TLM_SERVER_SECURE = /^true$/i.test(process.env.TLM_SERVER_SECURE || "false");
// Adjust if your server's virtual root already lands inside TSUDA (i.e. use "" instead of "/TSUDA").
const TLM_SERVER_BASE_PATH = process.env.TLM_SERVER_BASE_PATH || "/TSUDA";
// TLM itself only refreshes every ~10-16 min, so polling this faster just adds
// load on the main PC for no benefit. Default is deliberately conservative.
const TLM_SERVER_POLL_INTERVAL_MS = toInteger(process.env.TLM_SERVER_POLL_INTERVAL_MS, 300000);
const TLM_SERVER_TIMEOUT_MS = toInteger(process.env.TLM_SERVER_TIMEOUT_MS, 15000);

const MIN_COUNTED_STOP_SECONDS = toInteger(process.env.MIN_COUNTED_STOP_SECONDS, 0);
const STOP_HIGHLIGHT_SECONDS = toInteger(process.env.STOP_HIGHLIGHT_SECONDS, 150); // 2.5 min

const LOOM_UTC_OFFSET = process.env.LOOM_UTC_OFFSET || "+05:30";
const HTTP_PORT = toInteger(process.env.PORT, 3001);
const MACHINE_CACHE_FILE = process.env.MACHINE_CACHE_FILE || path.join(path.dirname(process.execPath), "tsudakoma-machine-cache.json");
const MACHINE_REFRESH_MS = toInteger(process.env.MACHINE_REFRESH_MS, 300000);
const DATA_PUSH_INTERVAL_MS = toInteger(process.env.DATA_PUSH_INTERVAL_MS, 5000);
const POWER_OFF_AFTER_MS = toInteger(process.env.POWER_OFF_AFTER_MS, 90000);
const FTP_ERROR_LOG_COOLDOWN_MS = toInteger(process.env.FTP_ERROR_LOG_COOLDOWN_MS, 300000);
const SLOW_FTP_READ_MS = toInteger(process.env.SLOW_FTP_READ_MS, 5000);
const SLOW_FTP_QUEUE_MS = toInteger(process.env.SLOW_FTP_QUEUE_MS, 5000);
const HEALTH_SUMMARY_INTERVAL_MS = toInteger(process.env.HEALTH_SUMMARY_INTERVAL_MS, 300000);
const APP_STARTED_AT = Date.now();
const STARTUP_LOG_GRACE_MS = 60000;

const POWER_OFF_STOP_CODE = 9999;
const UNKNOWN_STOP_CODE = 9998;

const RAW_INDEX = Object.freeze({
    shift: 0,
    quality: 1,
    stopCode: 2,
    runTime: 3,
    efficiencyPercent: 4,
    currentDensity: 5,
    pieceLengthM: 6,
    picksCurrentShift: 7,
    beamLeft: 8,
    initialBeamLeft: 9,
    beamCompletionDate: 10,
    warpStopCount: 11,
    warpStopDuration: 12,
    h1StopCount: 13,
    h1StopDuration: 14,
    h2StopCount: 15,
    h2StopDuration: 16,
    otherStopCount: 17,
    otherStopDuration: 18,
    speedRpm: 19
});

const axiosInstance = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ keepAlive: false })
});

let machineData = {};
let loomNoToMachineId = new Map();
const pollers = new Map();
let shuttingDown = false;
let machineApiOffline = false;
let dataPushOffline = false;
let tlmServerOffline = false;

// Latest snapshot from the TLM main computer, keyed by loom number (integer).
let tlmServerProductionByLoom = new Map();
let tlmServerStatusByLoom = new Map();
let tlmServerShiftDataByLoom = new Map();
let tlmServerLastFetchedAt = null;
let pendingClosedShiftLogs = []; // retry queue - not persisted across restarts

const healthStats = {
    ftpReads: 0,
    ftpReadErrors: 0,
    totalReadMs: 0,
    maxReadMs: 0,
    totalQueueMs: 0,
    maxQueueMs: 0,
    slowReads: 0,
    slowQueues: 0
};

// ====== HELPERS ======
function toInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback || 0;
}

function toNumber(value, fallback) {
    const parsed = Number.parseFloat(String(value === undefined || value === null ? "" : value).trim());
    return Number.isFinite(parsed) ? parsed : fallback || 0;
}

function toSystemShift(rawShift) {
    const shift = toInteger(rawShift);
    return shift > 0 ? shift - 1 : shift;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcNow() {
    return moment.utc().format();
}

function loomDateTimeToUtc(date, time) {
    const normalizedDate = String(date || "").trim().replace(/\//g, "-");
    const timeParts = String(time || "").trim().split(":");

    const normalizedTime = timeParts.length === 3
        ? `${timeParts[0].padStart(2, "0")}:${timeParts[1].padStart(2, "0")}:${timeParts[2].padStart(2, "0")}`
        : String(time || "").trim();

    const parsed = moment.parseZone(
        `${normalizedDate}T${normalizedTime}${LOOM_UTC_OFFSET}`,
        "YYYY-MM-DDTHH:mm:ssZ",
        true
    );

    return parsed.isValid() ? parsed.utc().format() : null;
}

function blankStopsData() {
    return {
        warp: [],
        weft: [],
        feeder: [],
        manual: [],
        other: [],
        h1: [],
        h2: []
    };
}

function ensureMachineData(machine) {
    const machineId = String(machine.id);

    if (!machineData[machineId]) {
        machineData[machineId] = {
            displayType: machine.displayType || "tsudakoma",
            stopCount: 0,
            totalStopCount: 0,
            stopsData: blankStopsData(),
            lastStopTime: null,
            lastStartTime: null,
            stop: 0,
            shift: null,
            isPowerOff: false,
            lastLoggedFtpError: null,
            lastLoggedFtpErrorAt: null,
            wasFtpOffline: false
        };
    }

    const data = machineData[machineId];
    data.displayType = machine.displayType || "tsudakoma";
    data.stopsData = { ...blankStopsData(), ...(data.stopsData || {}) };

    return data;
}

function saveMachineCache(initData) {
    try {
        const payload = JSON.stringify({
            savedAt: utcNow(),
            data: initData
        });
        const tempFile = MACHINE_CACHE_FILE + ".tmp";

        fs.writeFileSync(tempFile, payload);
        fs.renameSync(tempFile, MACHINE_CACHE_FILE);
    } catch (error) {
        console.error(
            `[${utcNow()}] Failed to write machine cache:`,
            error && error.message ? error.message : error
        );
    }
}

function loadMachineCache() {
    try {
        if (!fs.existsSync(MACHINE_CACHE_FILE)) {
            return null;
        }

        return JSON.parse(fs.readFileSync(MACHINE_CACHE_FILE, "utf8"));
    } catch (error) {
        console.warn(
            `[${utcNow()}] Failed to read machine cache:`,
            error && error.message ? error.message : error
        );
        return null;
    }
}

function isExpectedOptionalFileError(error) {
    const message = error && error.message ? error.message : String(error || "");

    return message.indexOf("550") >= 0 ||
        /file unavailable/i.test(message) ||
        /file not found/i.test(message);
}

function shouldLogFtpError(state, error) {
    const message = error && error.message ? error.message : String(error || "");
    const now = Date.now();

    if (message !== state.lastLoggedFtpError) {
        state.lastLoggedFtpError = message;
        state.lastLoggedFtpErrorAt = now;
        return true;
    }

    if (!state.lastLoggedFtpErrorAt || now - state.lastLoggedFtpErrorAt >= FTP_ERROR_LOG_COOLDOWN_MS) {
        state.lastLoggedFtpError = message;
        state.lastLoggedFtpErrorAt = now;
        return true;
    }

    return false;
}

function isTsudakomaMachine(machine) {
    const type = String(machine.displayType || "").toLowerCase();

    if (!type) return true;

    return [
        "tsudakoma",
        "tsudokuma",
        "tsudakoma-airjet",
        "tsudakoma_airjet"
    ].includes(type);
}

function resolveLoomNumber(machine) {
    const explicitLoomNo = machine.tsudakomaLoomNo || machine.ftpLoomNo;

    if (explicitLoomNo) {
        const number = Number.parseInt(explicitLoomNo, 10);
        if (number > 0) return number;
    }

    const octets = String(machine.ip || "").split(".").map(Number);

    if (octets.length === 4 && octets.every(Number.isFinite)) {
        const loomNo = ((octets[2] - 1) * 256) + octets[3] + 1;
        if (loomNo > 0) return loomNo;
    }

    throw new Error(`Cannot resolve Tsudakoma loom number for machine ${machine.id}`);
}

function ftpCredentials(machine) {
    return {
        user: machine.ftpUsername || machine.ftpUser || FTP_USERNAME,
        password: machine.ftpPassword || FTP_PASSWORD
    };
}

// ====== CSV ======
function parseCsvLine(line) {
    const fields = [];
    let value = "";
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];

        if (char === '"') {
            if (quoted && line[index + 1] === '"') {
                value += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (char === "," && !quoted) {
            fields.push(value);
            value = "";
        } else {
            value += char;
        }
    }

    fields.push(value);

    return fields;
}

function parseCsvRows(text) {
    return String(text || "")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map(parseCsvLine);
}

// Generic parser for the TLM-server files that DO have a real header row
// (Status_*.CSV, Product_Loom.CSV, KIDAIM.CSV, etc). Returns an array of
// plain objects keyed by the trimmed header names.
function parseHeaderedCsv(text) {
    const rows = parseCsvRows(text);

    if (rows.length < 2) return [];

    const headers = rows[0].map((h) => String(h).trim());

    return rows.slice(1).map((row) => {
        const record = {};

        headers.forEach((header, index) => {
            record[header] = row[index] !== undefined ? String(row[index]).trim() : "";
        });

        return record;
    });
}

// ====== FTP CONCURRENCY ======
class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.waiters = [];
    }

    async acquire() {
        if (this.active < this.limit) {
            this.active += 1;
            return;
        }

        await new Promise((resolve) => this.waiters.push(resolve));
        this.active += 1;
    }

    release() {
        this.active = Math.max(0, this.active - 1);

        const next = this.waiters.shift();
        if (next) next();
    }

    async use(fn) {
        await this.acquire();

        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

const ftpSemaphore = new Semaphore(MAX_CONCURRENT_FTP);

class MemoryWritable extends Writable {
    constructor() {
        super();
        this.chunks = [];
    }

    _write(chunk, encoding, callback) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
    }

    text() {
        return Buffer.concat(this.chunks).toString("utf8");
    }
}

async function downloadText(client, remotePath) {
    const target = new MemoryWritable();

    await client.downloadTo(target, remotePath);

    return target.text();
}

function isRetryableFileError(error) {
    const message = error && error.message ? error.message : String(error || "");

    return message.indexOf("550") >= 0 || /file unavailable/i.test(message);
}

async function downloadTextWithRetry(client, remotePath) {
    let lastError = null;

    for (let attempt = 0; attempt <= FTP_FILE_RETRY_COUNT; attempt += 1) {
        try {
            return await downloadText(client, remotePath);
        } catch (error) {
            lastError = error;

            if (attempt >= FTP_FILE_RETRY_COUNT || !isRetryableFileError(error)) {
                throw error;
            }

            await sleep(FTP_FILE_RETRY_DELAY_MS * (attempt + 1));
        }
    }

    throw lastError;
}

// ====== DIRECT-TO-LOOM: STATUS ONLY (fast, 90s) ======
function parseStatusCsv(text) {
    const rows = parseCsvRows(text);

    if (!rows.length || rows[0].length < 33) {
        throw new Error("I_STATUS.CSV has an invalid or incomplete row");
    }

    const row = rows[0];
    const runFlag = toInteger(row[2]);
    const rawStopCode = toInteger(row[4]);
    const currentStop = runFlag === 1 ? 0 : rawStopCode || UNKNOWN_STOP_CODE;

    const beamOriginalMeter = toNumber(row[24]) / 10;
    const beamConsumedMeter = toNumber(row[26]) / 10;
    const beamLeftMeter = Math.max(0, beamOriginalMeter - beamConsumedMeter);
    const beamRemainingHours = Math.max(0, toNumber(row[31]));

    return {
        sourceDate: String(row[0]).trim(),
        sourceTime: String(row[1]).trim(),
        sourceTimestamp: loomDateTimeToUtc(row[0], row[1]),
        runFlag,
        currentStop,
        rawStopCode,
        status: toInteger(row[3]),
        doffNo: toInteger(row[18]),
        clothTargetMeter: toNumber(row[19]) / 10,
        clothRuntimeRaw: toNumber(row[20]),
        directClothPicks: toNumber(row[21]),
        currentPieceMeter: toNumber(row[22]) / 10,
        beamOriginalMeter: round(beamOriginalMeter, 1),
        beamConsumedMeter: round(beamConsumedMeter, 1),
        beamLeftMeter: round(beamLeftMeter, 1),
        clothRemainingMinutes: toNumber(row[29]) / 10,
        beamRemainingHours,
        raw: row
    };
}

function round(value, decimals) {
    if (!Number.isFinite(value)) return 0;

    const decimalPlaces = decimals === undefined ? 1 : decimals;
    const factor = 10 ** decimalPlaces;

    return Math.round(value * factor) / factor;
}

async function readLoomStatus(machine) {
    async function doRead() {
        const client = new ftp.Client(FTP_TIMEOUT_MS);
        client.prepareTransfer = ftp.enterPassiveModeIPv4;
        client.ftp.verbose = /^true$/i.test(process.env.FTP_VERBOSE || "false");

        const credentials = ftpCredentials(machine);
        const loomNo = resolveLoomNumber(machine);
        const startedAt = Date.now();

        try {
            await client.access({
                host: machine.ip,
                port: toInteger(machine.ftpPort, FTP_PORT),
                user: credentials.user,
                password: credentials.password,
                secure: FTP_SECURE
            });

            const statusText = await downloadTextWithRetry(client, "I_STATUS.CSV");

            return {
                status: parseStatusCsv(statusText),
                loomNo,
                readDurationMs: Date.now() - startedAt
            };
        } finally {
            client.close();
        }
    }

    const queueStartedAt = Date.now();
    const result = await ftpSemaphore.use(doRead);

    result.queueWaitMs = Math.max(0, Date.now() - queueStartedAt - result.readDurationMs);

    return result;
}

// ====== STOP CODES ======
const STOP_CODE = Object.freeze({
    20: { reason: "H1 feeler C1", bucket: "h1", group: "filling" },
    21: { reason: "H1 feeler C2", bucket: "h1", group: "filling" },
    25: { reason: "H2 feeler C1", bucket: "h2", group: "filling" },
    26: { reason: "H2 feeler C2", bucket: "h2", group: "filling" },
    31: { reason: "Dropper", bucket: "warp", group: "warp" },
    41: { reason: "Leno left", bucket: "warp", group: "warp" },
    42: { reason: "Leno right", bucket: "warp", group: "warp" },
    43: { reason: "CC", bucket: "warp", group: "warp" },
    50: { reason: "Package sensor C1", bucket: "other", group: "other" },
    51: { reason: "Package sensor C2", bucket: "other", group: "other" },
    71: { reason: "Counter", bucket: "other", group: "other" },
    11: { reason: "Stop button", bucket: "other", group: "other" }
});

function stopDefinition(code) {
    return STOP_CODE[code] || {
        reason: `Tsudakoma stop ${code}`,
        bucket: "other",
        group: "other"
    };
}

// ====== LIVE STOP TRACKING (derived purely from the 90s status polls) ======
// We no longer pull I_SHIFTEVT.CSV per loom, so this live transition tracking
// is now the ONLY source of stop start/end/duration. Resolution is bounded by
// STATUS_POLL_INTERVAL_MS - a stop's recorded start can lag its real start by
// up to that interval.
function closeLiveStop(machineState, endTime) {
    if (!machineState.lastStopTime || !machineState.stop) return;

    const duration = Math.max(
        0,
        moment.utc(endTime).diff(moment.utc(machineState.lastStopTime), "seconds")
    );

    if (duration < MIN_COUNTED_STOP_SECONDS) return;

    const definition = machineState.stop === POWER_OFF_STOP_CODE
        ? { reason: "Power Off", bucket: "other", group: "other" }
        : stopDefinition(machineState.stop);

    machineState.stopsData[definition.bucket].push({
        start: machineState.lastStopTime,
        end: endTime,
        statusCode: machineState.stop,
        duration,
        reason: definition.reason
    });

    machineState.stopCount += 1;
    machineState.totalStopCount += 1;
}

function applyStopTransition(machineState, newStop, eventTimestamp) {
    const now = eventTimestamp || utcNow();
    const previousStop = toInteger(machineState.stop);

    if (previousStop === 0 && newStop !== 0) {
        machineState.lastStopTime = now;
    } else if (previousStop !== 0 && newStop === 0) {
        closeLiveStop(machineState, now);
        machineState.lastStartTime = now;
        machineState.lastStopTime = null;
    } else if (previousStop !== 0 && newStop !== 0 && previousStop !== newStop) {
        closeLiveStop(machineState, now);
        machineState.lastStopTime = now;
    }

    machineState.stop = newStop;
}

function stoppedForSeconds(state, nowIso) {
    if (!state.stop || !state.lastStopTime) return 0;

    return Math.max(0, moment.utc(nowIso).diff(moment.utc(state.lastStopTime), "seconds"));
}

// ====== TLM MAIN-SERVER FTP READER (slow, production data) ======
// Reads TLMServer.exe's export of C:\TSUDA on the TLM main computer.
// Confirmed-good sources (real header rows, verified against sample data):
//   TLM/Status/Status_*.CSV      - one row per loom, all-machine snapshot
//   TLM/Product-Data/Product_Loom.CSV - per-loom style/lot production baselines
//
// NOT wired up here: Day-Data / Week-Data / Month-Data / Event-Data / Shift-Data.
// Those files have no header row - columns are positional and we have not
// verified their layout. Wiring efficiency/RPM/picks history from them without
// confirming against the bundled Excel templates (TLM\Program\Excel\*.xls) would
// mean silently showing wrong numbers, so they're deliberately left out for now.
async function fetchTlmServerFile(client, remotePath) {
    return downloadTextWithRetry(client, remotePath);
}

async function findLatestFile(client, dirPath, pattern) {
    const list = await client.list(dirPath);
    const matches = list
        .filter((item) => item.isFile && pattern.test(item.name))
        .map((item) => item.name)
        .sort();

    return matches.length ? matches[matches.length - 1] : null;
}

function parseTlmServerStatusRow(row) {
    // Header (verified from a real export):
    // LoomNo,CurrDate,CurrTime,Run/Stop,Status,StopCode,CtlHost/Loom,TRBSW,APRSW,
    // FeelerSW,H1TRB,SensorSW,CntSW,RTCbatER,FixCall,DoffCall,TRBCode,Dia(R),Dia(L),
    // DoffNo,ClothCutLng,ClothRunTm,ClothPicks,ClothLng,ClothUnit,BeamSlashLng,
    // BeamRunTime,BeamLng,BeamUnit,Status(T),ClothRemainMin,BeamRemainHour(T),
    // BeamRemainHour(B),BeamSlash(T)
    const loomNo = Number.parseInt(String(row.LoomNo || "").replace(/^L/i, ""), 10);

    return {
        loomNo,
        sourceDate: row.CurrDate,
        sourceTime: row.CurrTime,
        sourceTimestamp: loomDateTimeToUtc(row.CurrDate, row.CurrTime),
        runFlag: toInteger(row["Run/Stop"]),
        stopCode: toInteger(row.StopCode),
        doffNo: toInteger(row.DoffNo),
        clothRemainingMinutes: toNumber(row.ClothRemainMin) / 10,
        beamRemainingHoursTop: toNumber(row["BeamRemainHour(T)"]),
        beamRemainingHoursBottom: toNumber(row["BeamRemainHour(B)"]),
        raw: row
    };
}

// TLM/Shift-Data/L0xx_<timestamp>.CSV - one row per shift, oldest first.
// The LAST row is always the current in-progress shift. When a shift closes,
// TLM finalizes that row (round shift-end time, elapsed=~720) and appends a
// NEW last row for the next shift - that row-count growth is how we detect
// a closed shift (see detectClosedShifts below), not a wall-clock guess.
//
// All columns below are verified against real TLM report output
// (Term_report.xls "Report by term" tab, cross-checked field by field):
//   0-3   shift start/end date+time, shift number
//   4     rpm
//   5     elapsedMinutes x10        (TLM calls this "monitored time")
//   6     runtimeMinutes x10        (= elapsed - totalStopMinutes)
//   9-11  total/filling/warp stop MINUTES x10 (aggregates; filling = h1+h2)
//   12-14 total/filling/warp stop COUNTS
//   15-22 H1 feeler C1-C8 counts       45-52 H1 feeler C1-C8 durations x10
//   23-30 H2 feeler C1-C8 counts       53-60 H2 feeler C1-C8 durations x10
//   31-34 Dropper/LenoL/LenoR/CC counts 61-64 same, durations x10
//   35-42 Package sensor C1-C8 counts  65-72 same, durations x10
//   43-44 Counter/StopButton counts    73-74 same, durations x10
//
// efficiencyPercent = runtime/elapsed*100. Per the manual (B704-5, Note 1),
// this is the formula for BOTH Mill and Loom efficiency; they only differ
// when a loom loses power mid-shift, which we have no confirmed column for
// yet, so this one formula is used for both.
const SHIFT_DATA_INDEX = Object.freeze({
    shiftStartDate: 0,
    shift: 1,
    shiftEndDate: 2,
    shiftEndTime: 3,
    rpm: 4,
    elapsedMinutesX10: 5,
    runtimeMinutesX10: 6,
    picksX100: 7,          // manual item 8: "Woven cloth pick number [100 picks]"
    clothLengthX10: 8,     // manual item 9: "Woven cloth length [0.1 m]"
    totalStopMinutesX10: 9,
    totalStopCount: 12
});

function sumRange(row, start, end) {
    let total = 0;
    for (let i = start; i <= end; i += 1) {
        total += toNumber(row[i]);
    }
    return total;
}

function parseShiftDataRow(row) {
    const elapsedMinutes = toNumber(row[SHIFT_DATA_INDEX.elapsedMinutesX10]) / 10;
    const runtimeMinutes = toNumber(row[SHIFT_DATA_INDEX.runtimeMinutesX10]) / 10;

    const efficiencyPercent = elapsedMinutes > 0
        ? round((runtimeMinutes / elapsedMinutes) * 100, 1)
        : 0;

    const stopBreakdown = {
        h1: {
            count: sumRange(row, 15, 22),
            duration: round(sumRange(row, 45, 52) / 10, 1)
        },
        h2: {
            count: sumRange(row, 23, 30),
            duration: round(sumRange(row, 53, 60) / 10, 1)
        },
        // Dropper, Leno-left, Leno-right, CC - matches TLM's own "Warp stop" grouping
        warp: {
            count: sumRange(row, 31, 34),
            duration: round(sumRange(row, 61, 64) / 10, 1)
        },
        // Package sensor x8 + Counter + Stop button
        other: {
            count: sumRange(row, 35, 44),
            duration: round(sumRange(row, 65, 74) / 10, 1)
        }
    };

    return {
        shiftStartDate: String(row[SHIFT_DATA_INDEX.shiftStartDate] || "").trim(),
        shift: toInteger(row[SHIFT_DATA_INDEX.shift]),
        shiftEndDate: String(row[SHIFT_DATA_INDEX.shiftEndDate] || "").trim(),
        shiftEndTime: String(row[SHIFT_DATA_INDEX.shiftEndTime] || "").trim(),
        rpm: toNumber(row[SHIFT_DATA_INDEX.rpm]),
        elapsedMinutes: round(elapsedMinutes, 1),
        runtimeMinutes: round(runtimeMinutes, 1),
        efficiencyPercent,
        picks: toNumber(row[SHIFT_DATA_INDEX.picksX100]) * 100, // manual: units of 100 picks
        clothLengthMeter: round(toNumber(row[SHIFT_DATA_INDEX.clothLengthX10]) / 10, 1),
        totalStopMinutes: round(toNumber(row[SHIFT_DATA_INDEX.totalStopMinutesX10]) / 10, 1),
        totalStopCount: toInteger(row[SHIFT_DATA_INDEX.totalStopCount]),
        stopBreakdown,
        raw: row
    };
}

function parseTlmServerProductLoomRow(row) {
    // Header (verified from a real export):
    // LoomNo,StyleNo,S_YYYYMMDD,S_Shift,S_0.1m,S_Picks,S_Pieces,LotNo,
    // L_YYYYMMDD,L_Shift,L_0.1m,L_Picks,L_Pieces,S_0.01m,L_0.01m
    // S_ fields = counter baseline at style start, L_ fields = counter baseline
    // at lot start. These are NOT live shift efficiency/RPM figures.
    const loomNo = Number.parseInt(String(row.LoomNo || "").replace(/^L/i, ""), 10);

    return {
        loomNo,
        styleNo: (row.StyleNo || "").trim(),
        lotNo: (row.LotNo || "").trim(),
        styleStartDate: row.S_YYYYMMDD,
        styleStartShift: toInteger(row.S_Shift),
        styleStartMeter: toNumber(row["S_0.1m"]) / 10,
        styleStartPicks: toNumber(row.S_Picks),
        styleStartPieces: toNumber(row.S_Pieces),
        lotStartDate: row.L_YYYYMMDD,
        lotStartShift: toInteger(row.L_Shift),
        lotStartMeter: toNumber(row["L_0.1m"]) / 10,
        lotStartPicks: toNumber(row.L_Picks),
        lotStartPieces: toNumber(row.L_Pieces),
        raw: row
    };
}

async function readTlmServerSnapshot() {
    if (!TLM_SERVER_HOST) {
        throw new Error("TLM_SERVER_HOST is not configured");
    }

    const client = new ftp.Client(TLM_SERVER_TIMEOUT_MS);
    client.prepareTransfer = ftp.enterPassiveModeIPv4;
    client.ftp.verbose = /^true$/i.test(process.env.FTP_VERBOSE || "false");

    const statusByLoom = new Map();
    const productionByLoom = new Map();
    const shiftDataByLoom = new Map();

    try {
        await client.access({
            host: TLM_SERVER_HOST,
            port: TLM_SERVER_PORT,
            user: TLM_SERVER_USER,
            password: TLM_SERVER_PASSWORD,
            secure: TLM_SERVER_SECURE
        });

        const statusDir = `${TLM_SERVER_BASE_PATH}/TLM/Status`;
        const latestStatusFile = await findLatestFile(client, statusDir, /^Status_\d+\.CSV$/i);

        if (latestStatusFile) {
            const text = await fetchTlmServerFile(client, `${statusDir}/${latestStatusFile}`);

            for (const row of parseHeaderedCsv(text)) {
                const parsed = parseTlmServerStatusRow(row);
                if (Number.isFinite(parsed.loomNo)) {
                    statusByLoom.set(parsed.loomNo, parsed);
                }
            }
        } else {
            console.warn(`[${utcNow()}] TLM server: no Status_*.CSV found in ${statusDir}`);
        }

        const productLoomPath = `${TLM_SERVER_BASE_PATH}/TLM/Product-Data/Product_Loom.CSV`;
        const productText = await fetchTlmServerFile(client, productLoomPath);

        for (const row of parseHeaderedCsv(productText)) {
            const parsed = parseTlmServerProductLoomRow(row);
            if (Number.isFinite(parsed.loomNo)) {
                productionByLoom.set(parsed.loomNo, parsed);
            }
        }

        // Shift-Data: one file per loom, filename carries a timestamp, so we
        // list the directory once and match "L0xx_..." per loom rather than
        // guessing the current filename.
        const shiftDataDir = `${TLM_SERVER_BASE_PATH}/TLM/Shift-Data`;
        const shiftDataFiles = await client.list(shiftDataDir);
        const shiftDataByLoomNo = new Map();

        for (const item of shiftDataFiles) {
            const match = item.isFile && item.name.match(/^L(\d{3})_\d+\.CSV$/i);
            if (match) {
                shiftDataByLoomNo.set(Number.parseInt(match[1], 10), item.name);
            }
        }

        for (const [loomNo, fileName] of shiftDataByLoomNo.entries()) {
            try {
                const text = await fetchTlmServerFile(client, `${shiftDataDir}/${fileName}`);
                const rows = parseCsvRows(text);

                if (rows.length) {
                    // Keep ALL parsed rows (not just the last) - row-count
                    // growth between refreshes is how we detect a shift close.
                    shiftDataByLoom.set(loomNo, rows.map(parseShiftDataRow));
                }
            } catch (error) {
                console.warn(
                    `[${utcNow()}] TLM server: could not read Shift-Data for L${String(loomNo).padStart(3, "0")}: ${error.message}`
                );
            }
        }

        return { statusByLoom, productionByLoom, shiftDataByLoom };
    } finally {
        client.close();
    }
}

async function tlmServerRefreshLoop() {
    if (!TLM_SERVER_HOST) {
        console.warn(
            `[${utcNow()}] TLM_SERVER_HOST is not set - skipping TLM main-server production reader.`
        );
        return;
    }

    while (!shuttingDown) {
        try {
            const snapshot = await readTlmServerSnapshot();

            tlmServerStatusByLoom = snapshot.statusByLoom;
            tlmServerProductionByLoom = snapshot.productionByLoom;
            tlmServerShiftDataByLoom = snapshot.shiftDataByLoom;
            tlmServerLastFetchedAt = utcNow();

            applyTlmServerDataToMachines();

            if (tlmServerOffline) {
                console.log(`[${tlmServerLastFetchedAt}] TLM main-server FTP recovered.`);
                tlmServerOffline = false;
            }
        } catch (error) {
            if (!tlmServerOffline) {
                tlmServerOffline = true;
                console.error(
                    `[${utcNow()}] TLM main-server FTP read failed:`,
                    error && error.message ? error.message : error
                );
            }
        }

        await sleep(TLM_SERVER_POLL_INTERVAL_MS);
    }
}

function applyTlmServerDataToMachines() {
    const closedShiftLogs = [];

    for (const [loomNo, machineId] of loomNoToMachineId.entries()) {
        const state = machineData[machineId];
        if (!state) continue;

        const production = tlmServerProductionByLoom.get(loomNo);

        if (production) {
            state.styleNo = production.styleNo || state.styleNo;
            state.lotNo = production.lotNo;
            state.lotStartMeter = production.lotStartMeter;
            state.lotStartPicks = production.lotStartPicks;
            state.lotStartPieces = production.lotStartPieces;
            state.styleStartMeter = production.styleStartMeter;
            state.styleStartPicks = production.styleStartPicks;
        }

        const shiftRows = tlmServerShiftDataByLoom.get(loomNo);

        if (shiftRows && shiftRows.length) {
            const previousRowCount = Number.isInteger(state.shiftDataRowCount)
                ? state.shiftDataRowCount
                : shiftRows.length; // first sighting of this loom: nothing to close yet, just baseline

            if (shiftRows.length > previousRowCount) {
                // One or more shifts finalized since our last check. Every row
                // from the old "last" index up to (but not including) the new
                // last row is now guaranteed-final.
                for (let i = previousRowCount - 1; i < shiftRows.length - 1; i += 1) {
                    closedShiftLogs.push(buildClosedShiftLog(machineOf(machineId, state), state, shiftRows[i]));
                }

                // Reset live per-shift tracking for the new in-progress shift.
                state.stopsData = blankStopsData();
                state.stopCount = 0;
                state.totalStopCount = 0;
                state.lastStartTime = null;
                // Deliberately NOT clearing lastStopTime/stop: if the loom is
                // stopped right through the boundary, stoppedForSeconds must
                // keep counting through the shift change.
            }

            state.shiftDataRowCount = shiftRows.length;

            const currentShiftRow = shiftRows[shiftRows.length - 1];

            state.shift = toSystemShift(currentShiftRow.shift);
            state.averageRpm = currentShiftRow.rpm;
            state.elapsedMinutes = currentShiftRow.elapsedMinutes;
            state.runtimeMinutes = currentShiftRow.runtimeMinutes;
            state.efficiency = currentShiftRow.efficiencyPercent;
            state.currentShiftPicksFromTlm = currentShiftRow.picks; // manual-confirmed, refreshes ~5 min
            state.currentShiftClothLength = currentShiftRow.clothLengthMeter;
            state.stopBreakdown = currentShiftRow.stopBreakdown; // {warp,h1,h2,other}: {count,duration}
        }

        state.tlmServerLastSyncAt = tlmServerLastFetchedAt;
    }

    if (closedShiftLogs.length) {
        sendClosedShiftLogs(closedShiftLogs);
    }
}

// machineData is keyed by id only; the actual machine record (ip, displayType
// etc.) lives on the poller control.
function machineOf(machineId, state) {
    const control = pollers.get(machineId);
    return control ? control.machine : { id: machineId, displayType: state.displayType };
}

function buildClosedShiftLog(machine, state, closedRow) {
    const breakdown = closedRow.stopBreakdown;

    const stopsData = {
        ...blankStopsData(),
        warp: [{ count: breakdown.warp.count, duration: breakdown.warp.duration * 60, reason: "Warp (TLM shift total)" }],
        h1: [{ count: breakdown.h1.count, duration: breakdown.h1.duration * 60, reason: "H1 feeler (TLM shift total)" }],
        h2: [{ count: breakdown.h2.count, duration: breakdown.h2.duration * 60, reason: "H2 feeler (TLM shift total)" }],
        other: [{ count: breakdown.other.count, duration: breakdown.other.duration * 60, reason: "Other (TLM shift total)" }]
    };

    const rawData = [
        toSystemShift(closedRow.shift),
        state.styleNo || "",
        0, // stopCode - shift is closed, no "current" stop to report
        closedRow.runtimeMinutes,
        closedRow.efficiencyPercent,
        0, // currentDensity - out of scope for now
        state.currentPieceMeter || 0,
        state.currentShiftPicks || 0,
        state.beamLeftMeter || 0,
        state.beamOriginalMeter || 0,
        state.beamCompletionDatetime || null,
        breakdown.warp.count,
        breakdown.warp.duration,
        breakdown.h1.count,
        breakdown.h1.duration,
        breakdown.h2.count,
        breakdown.h2.duration,
        breakdown.other.count,
        breakdown.other.duration,
        closedRow.rpm
    ];

    return {
        machineId: String(machine.id),
        displayType: state.displayType,
        shift: toSystemShift(closedRow.shift),
        quality: state.styleNo || "",
        stopsData,
        stopCount: closedRow.totalStopCount,
        rawData,
        lastStartTime: state.lastStartTime,
        lastStopTime: state.lastStopTime,
        updatedTime: utcNow()
    };
}

async function sendClosedShiftLogs(logs) {
    const toSend = pendingClosedShiftLogs.concat(logs);

    try {
        await axiosInstance.post(
            `${API_BASE_URL}/machine-logs/shift`,
            {
                // ARRAY of log objects, each carrying its own machineId - this
                // endpoint's body shape differs from the regular /machine-logs
                // push, which is an object keyed by machineId.
                logs: toSend,
                workspaceId: WORKSPACE_ID,
                apiKey: API_KEY
            }
        );

        pendingClosedShiftLogs = [];
        console.log(`[${utcNow()}] Sent ${toSend.length} closed-shift log(s) to TrackWeaving.`);
    } catch (error) {
        // Keep them for the next attempt (next TLM-server refresh cycle, or
        // process restart loses this queue - it's in-memory only). This is
        // the piece that makes "previous shift data accurate" hold even
        // across a transient API outage, rather than silently dropping it.
        pendingClosedShiftLogs = toSend;
        console.error(
            `[${utcNow()}] Failed to send closed-shift logs (${toSend.length} queued for retry):`,
            error && error.message ? error.message : error
        );
    }
}

// ====== MACHINE PROCESSING (per 90s status poll) ======
function processLoomStatus(machine, result, fetchedAt) {
    const machineId = String(machine.id);
    const state = ensureMachineData(machine);
    const status = result.status;

    /*
     * IMPORTANT: use fetchedAt (our own clock) for live stop transitions,
     * not the loom's own status timestamp.
     */
    applyStopTransition(state, status.currentStop, fetchedAt);

    state.updatedTime = fetchedAt;
    state.lastSuccessfulReadAt = fetchedAt;
    state.lastStatusSourceTimestamp = status.sourceTimestamp || null;
    state.firstConnectionFailureAt = null;
    state.isPowerOff = false;
    state.readError = null;

    state.runFlag = status.runFlag;
    state.stop = status.currentStop;
    state.currentStopReason = status.currentStop ? stopDefinition(status.currentStop).reason : null;
    state.stoppedForSeconds = stoppedForSeconds(state, fetchedAt);

    state.currentPieceMeter = status.currentPieceMeter;
    state.beamOriginalMeter = status.beamOriginalMeter;
    state.beamConsumedMeter = status.beamConsumedMeter;
    state.beamLeftMeter = status.beamLeftMeter;
    state.beamRemainingHours = status.beamRemainingHours;
    state.beamCompletionDatetime = status.beamRemainingHours > 0
        ? moment.utc(fetchedAt).add(status.beamRemainingHours, "hours").format()
        : null;
    state.doffNo = status.doffNo;
    // I_STATUS.CSV's own pick counter (directClothPicks) is unreliable/often
    // zero on the live status file - the original code even had a fallback
    // for this. The manual-confirmed source is Shift-Data item 8 ("Woven
    // cloth pick number [100 picks]"), refreshed ~5 min via the TLM server.
    state.currentShiftPicks = status.directClothPicks > 0
        ? status.directClothPicks
        : toNumber(state.currentShiftPicksFromTlm);

    // averageRpm comes from the TLM-server Shift-Data reader (confirmed
    // column, refreshed every TLM_SERVER_POLL_INTERVAL_MS). currentRpm is 0
    // while stopped, otherwise the last-known average for the shift.
    state.currentRpm = status.runFlag === 1 ? toNumber(state.averageRpm) : 0;

    state.rawData = [
        state.shift || 0,
        state.styleNo || "",
        status.currentStop,
        toNumber(state.runtimeMinutes), // from TLM server Shift-Data, refreshes ~5 min
        toNumber(state.efficiency),     // runtime / elapsed * 100 (manual's Mill/Loom formula), same refresh cadence
        0, // currentDensity - still no confirmed TLM-server source (see notes)
        status.currentPieceMeter,
        status.directClothPicks,
        status.beamLeftMeter,
        status.beamOriginalMeter,
        state.beamCompletionDatetime,
        // Warp/H1/H2/Other counts+durations: confirmed TLM-server ground truth
        // for the current shift-so-far (refreshes ~5 min), not our own live
        // 90s-polling approximation - see stopBreakdown in applyTlmServerDataToMachines.
        (state.stopBreakdown && state.stopBreakdown.warp.count) || 0,
        (state.stopBreakdown && state.stopBreakdown.warp.duration) || 0,
        (state.stopBreakdown && state.stopBreakdown.h1.count) || 0,
        (state.stopBreakdown && state.stopBreakdown.h1.duration) || 0,
        (state.stopBreakdown && state.stopBreakdown.h2.count) || 0,
        (state.stopBreakdown && state.stopBreakdown.h2.duration) || 0,
        (state.stopBreakdown && state.stopBreakdown.other.count) || 0,
        (state.stopBreakdown && state.stopBreakdown.other.duration) || 0,
        state.currentRpm || 0
    ];

    state.source = {
        loomStatusTimestamp: status.sourceTimestamp,
        collectedAt: fetchedAt,
        ftpIp: machine.ip,
        loomNo: result.loomNo,
        tlmServerLastSyncAt: state.tlmServerLastSyncAt || null
    };

    return machineData[machineId];
}

// ====== POWER OFF ======
function markMachinePowerOff(machine, error) {
    const state = ensureMachineData(machine);
    const now = utcNow();

    const lastSuccess = state.lastSuccessfulReadAt
        ? moment.utc(state.lastSuccessfulReadAt)
        : null;

    if (!state.firstConnectionFailureAt) {
        state.firstConnectionFailureAt = now;
    }

    const offlineFrom = lastSuccess || moment.utc(state.firstConnectionFailureAt);
    const offlineForMs = moment.utc(now).diff(offlineFrom);

    state.readError = error && error.message ? error.message : String(error);
    state.lastReadErrorAt = now;

    if (offlineForMs >= POWER_OFF_AFTER_MS && !state.isPowerOff) {
        applyStopTransition(state, POWER_OFF_STOP_CODE, now);

        state.isPowerOff = true;
        state.wasFtpOffline = true;
        state.currentStopReason = "Power Off";
        state.stoppedForSeconds = stoppedForSeconds(state, now);

        state.updatedTime = now;

        console.log(
            `[${now}] Machine offline/power-off: ${machine.ip}, offline=${Math.round(offlineForMs / 1000)}s`
        );
    }
}

// ====== POLLING (per loom, status only) ======
async function pollLoop(machine, control, initialDelayMs) {
    const machineId = String(machine.id);

    await sleep(initialDelayMs);

    let backoffMs = STATUS_POLL_INTERVAL_MS;

    while (!shuttingDown && !control.cancelled) {
        const startedAt = Date.now();

        try {
            const result = await readLoomStatus(control.machine);
            const fetchedAt = utcNow();

            processLoomStatus(control.machine, result, fetchedAt);

            backoffMs = STATUS_POLL_INTERVAL_MS;

            const state = machineData[machineId];

            healthStats.ftpReads += 1;
            healthStats.totalReadMs += result.readDurationMs;
            healthStats.totalQueueMs += result.queueWaitMs;

            if (result.readDurationMs > healthStats.maxReadMs) healthStats.maxReadMs = result.readDurationMs;
            if (result.queueWaitMs > healthStats.maxQueueMs) healthStats.maxQueueMs = result.queueWaitMs;

            const loomLabel = String(result.loomNo).padStart(3, "0");

            if (state.wasFtpOffline) {
                console.log(`[${fetchedAt}] FTP recovered: ${control.machine.ip} L${loomLabel}`);
                state.wasFtpOffline = false;
                state.lastLoggedFtpError = null;
                state.lastLoggedFtpErrorAt = null;
            }

            const startupGraceOver = Date.now() - APP_STARTED_AT >= STARTUP_LOG_GRACE_MS;

            if (startupGraceOver && result.readDurationMs >= SLOW_FTP_READ_MS) {
                healthStats.slowReads += 1;
                console.log(
                    `[${fetchedAt}] Slow FTP read ${control.machine.ip} L${loomLabel} read=${result.readDurationMs}ms queue=${result.queueWaitMs}ms`
                );
            }

            if (startupGraceOver && result.queueWaitMs >= SLOW_FTP_QUEUE_MS) {
                healthStats.slowQueues += 1;
                console.log(
                    `[${fetchedAt}] High FTP queue ${control.machine.ip} L${loomLabel} queue=${result.queueWaitMs}ms read=${result.readDurationMs}ms`
                );
            }

            if (state.stop && state.stoppedForSeconds >= STOP_HIGHLIGHT_SECONDS) {
                // This is the condition your dashboard card highlight should mirror.
                // Left as a log line here; TrackWeaving/backend can apply the same
                // check against `stop` + `stoppedForSeconds` in the pushed payload.
            }
        } catch (error) {
            const state = ensureMachineData(control.machine);
            state.wasFtpOffline = true;
            healthStats.ftpReadErrors += 1;

            if (shouldLogFtpError(state, error)) {
                console.error(
                    `[${utcNow()}] FTP read failed for ${control.machine.ip}:`,
                    error && error.message ? error.message : error
                );
            }

            markMachinePowerOff(control.machine, error);

            backoffMs = Math.min(
                Math.max(STATUS_POLL_INTERVAL_MS, Math.round(backoffMs * 1.5)),
                MAX_FAILURE_BACKOFF_MS + STATUS_POLL_INTERVAL_MS
            );
        }

        const elapsed = Date.now() - startedAt;
        const jitter = Math.floor(Math.random() * 1000);

        await sleep(Math.max(1000, backoffMs - elapsed) + jitter);
    }
}

function startOrUpdatePoller(machine, index) {
    const id = String(machine.id);
    const existing = pollers.get(id);

    if (existing) {
        existing.machine = machine;
        existing.cancelled = false;
        return;
    }

    const control = {
        machine,
        cancelled: false
    };

    pollers.set(id, control);
    ensureMachineData(machine);

    // Spread start times across the poll interval so 96 looms don't all
    // fire in the same instant - keeps effective concurrency close to
    // MAX_CONCURRENT_FTP instead of bursting past it every cycle.
    const spreadMs = Math.floor((index / Math.max(1, pollers.size)) * STATUS_POLL_INTERVAL_MS);

    pollLoop(machine, control, spreadMs).catch((error) => {
        handlePollLoopError(error, id);
    });
}

function handlePollLoopError(error, machineId) {
    console.error(`pollLoop crashed for machine ${machineId}:`, error);
    pollers.delete(machineId);
}

// ====== MACHINE LIST ======
async function fetchMachines() {
    const response = await axiosInstance.post(
        `${API_BASE_URL}/machine-logs/machine-list`,
        {
            workspaceId: WORKSPACE_ID,
            apiKey: API_KEY
        }
    );

    return response.data && response.data.data ? response.data.data : {};
}

function applyMachineConfiguration(initData) {
    const serverMachineData = initData.machineData || {};

    for (const [machineId, data] of Object.entries(serverMachineData)) {
        if (!machineData[machineId]) {
            machineData[machineId] = data;
        }
    }

    const machines = (initData.machines || []).filter(isTsudakomaMachine);
    const activeIds = new Set(machines.map((machine) => String(machine.id)));

    const newLoomMap = new Map();

    machines.forEach((machine, index) => {
        startOrUpdatePoller(machine, index);

        try {
            newLoomMap.set(resolveLoomNumber(machine), String(machine.id));
        } catch (error) {
            console.warn(`[${utcNow()}] Could not resolve loom number for machine ${machine.id}`);
        }
    });

    loomNoToMachineId = newLoomMap;

    for (const [id, control] of pollers.entries()) {
        if (!activeIds.has(id)) {
            control.cancelled = true;
            pollers.delete(id);
        }
    }

    return machines.length;
}

async function machineRefreshLoop() {
    const cached = loadMachineCache();

    if (cached && cached.data) {
        const cachedCount = applyMachineConfiguration(cached.data);
        console.log(`[${utcNow()}] Loaded ${cachedCount} Tsudakoma machines from local cache.`);
    }

    let retryMs = 10000;
    let loggedTrackWeavingLoad = false;

    while (!shuttingDown) {
        try {
            const initData = await fetchMachines();
            const machineCount = applyMachineConfiguration(initData);
            saveMachineCache(initData);

            if (machineApiOffline) {
                console.log(`[${utcNow()}] TrackWeaving machine API connection recovered. machines=${machineCount}`);
                machineApiOffline = false;
            } else if (!loggedTrackWeavingLoad) {
                console.log(`[${utcNow()}] Loaded ${machineCount} Tsudakoma machines from TrackWeaving.`);
            }

            loggedTrackWeavingLoad = true;
            retryMs = MACHINE_REFRESH_MS;
        } catch (error) {
            if (!machineApiOffline) {
                machineApiOffline = true;
                retryMs = 10000;
                console.error(
                    `[${utcNow()}] TrackWeaving machine API unavailable:`,
                    error && error.message ? error.message : error
                );
                console.log(
                    `[${utcNow()}] Continuing local FTP polling with ${pollers.size} existing machines.`
                );
            } else {
                retryMs = Math.min(retryMs * 2, 60000);
            }
        }

        await sleep(retryMs);
    }
}

// ====== DATA PUSH ======
async function dataPushLoop() {
    let delayMs = DATA_PUSH_INTERVAL_MS;

    while (!shuttingDown) {
        try {
            const dataToSend = {};
            const now = utcNow();

            for (const [machineId, data] of Object.entries(machineData)) {
                if (
                    data.updatedTime &&
                    moment.utc().diff(moment.utc(data.updatedTime), "hours") < 1
                ) {
                    dataToSend[machineId] = {
                        displayType: data.displayType,
                        lastStopTime: data.lastStopTime,
                        lastStartTime: data.lastStartTime,
                        stopCount: data.stopCount,
                        stopsData: data.stopsData,
                        stop: data.stop,
                        stoppedForSeconds: stoppedForSeconds(data, now),
                        powerOff: data.isPowerOff,
                        rawData: data.rawData,
                        shift: data.shift,
                        // From the TLM main-server reader (production totals only -
                        // see the note above readTlmServerSnapshot for what's NOT included)
                        styleNo: data.styleNo || null,
                        lotNo: data.lotNo || null,
                        lotStartMeter: data.lotStartMeter,
                        lotStartPicks: data.lotStartPicks,
                        elapsedMinutes: data.elapsedMinutes,
                        availableMinutes: data.availableMinutes,
                        runtimeMinutes: data.runtimeMinutes,
                        efficiency: data.efficiency,
                        averageRpm: data.averageRpm,
                        tlmServerLastSyncAt: data.tlmServerLastSyncAt || null
                    };
                }
            }

            if (Object.keys(dataToSend).length) {
                await axiosInstance.post(
                    `${API_BASE_URL}/machine-logs`,
                    {
                        logs: dataToSend,
                        workspaceId: WORKSPACE_ID,
                        apiKey: API_KEY
                    }
                );

                if (dataPushOffline) {
                    console.log(`[${utcNow()}] TrackWeaving data upload recovered.`);
                    dataPushOffline = false;
                }
            }

            delayMs = DATA_PUSH_INTERVAL_MS;
        } catch (error) {
            if (!dataPushOffline) {
                dataPushOffline = true;
                console.error(
                    `[${utcNow()}] TrackWeaving data upload unavailable:`,
                    error && error.message ? error.message : error
                );
                console.log(`[${utcNow()}] Local loom polling will continue.`);
            }

            delayMs = Math.min(delayMs * 2, 60000);
        }

        await sleep(delayMs);
    }
}

// ====== HEALTH ======
function logHealthSummary() {
    let powerOff = 0;
    let readErrors = 0;
    let highlighted = 0;

    const now = utcNow();

    for (const data of Object.values(machineData)) {
        if (data.isPowerOff) powerOff += 1;
        if (data.readError) readErrors += 1;
        if (data.stop && stoppedForSeconds(data, now) >= STOP_HIGHLIGHT_SECONDS) highlighted += 1;
    }

    const reads = healthStats.ftpReads;
    const avgRead = reads ? Math.round(healthStats.totalReadMs / reads) : 0;
    const avgQueue = reads ? Math.round(healthStats.totalQueueMs / reads) : 0;

    console.log(
        `[${now}] HEALTH machines=${pollers.size}` +
        ` powerOff=${powerOff}` +
        ` highlighted(>=${STOP_HIGHLIGHT_SECONDS}s)=${highlighted}` +
        ` readErrors=${readErrors}` +
        ` reads=${reads}` +
        ` ftpErrors=${healthStats.ftpReadErrors}` +
        ` avgRead=${avgRead}ms` +
        ` maxRead=${healthStats.maxReadMs}ms` +
        ` avgQueue=${avgQueue}ms` +
        ` maxQueue=${healthStats.maxQueueMs}ms` +
        ` slowReads=${healthStats.slowReads}` +
        ` slowQueues=${healthStats.slowQueues}` +
        ` machineApi=${machineApiOffline ? "DOWN" : "OK"}` +
        ` dataApi=${dataPushOffline ? "DOWN" : "OK"}` +
        ` tlmServer=${tlmServerOffline ? "DOWN" : "OK"}` +
        ` tlmServerLastSync=${tlmServerLastFetchedAt || "never"}`
    );

    healthStats.ftpReads = 0;
    healthStats.ftpReadErrors = 0;
    healthStats.totalReadMs = 0;
    healthStats.maxReadMs = 0;
    healthStats.totalQueueMs = 0;
    healthStats.maxQueueMs = 0;
    healthStats.slowReads = 0;
    healthStats.slowQueues = 0;
}

function healthHandler(req, res) {
    const now = utcNow();

    const machines = Object.entries(machineData).map(([id, data]) => ({
        id,
        updatedTime: data.updatedTime || null,
        stop: data.stop,
        stoppedForSeconds: stoppedForSeconds(data, now),
        highlighted: Boolean(data.stop) && stoppedForSeconds(data, now) >= STOP_HIGHLIGHT_SECONDS,
        isPowerOff: Boolean(data.isPowerOff),
        readError: data.readError || null
    }));

    res.json({
        ok: true,
        time: now,
        machineCount: machines.length,
        activePollers: pollers.size,
        machineApiOnline: !machineApiOffline,
        dataApiOnline: !dataPushOffline,
        tlmServerOnline: !tlmServerOffline,
        tlmServerLastFetchedAt,
        machines
    });
}

app.get("/health", healthHandler);

function healthServerStarted() {
    console.log(`Tsudakoma reader health server: http://localhost:${HTTP_PORT}/health`);

    console.log(
        `Status poll every ${STATUS_POLL_INTERVAL_MS}ms per loom, ` +
        `max concurrent FTP sessions ${MAX_CONCURRENT_FTP}, ` +
        `stop highlight threshold ${STOP_HIGHLIGHT_SECONDS}s, ` +
        `TLM server sync every ${TLM_SERVER_POLL_INTERVAL_MS}ms` +
        (TLM_SERVER_HOST ? ` (${TLM_SERVER_HOST})` : " (not configured)")
    );
}

// ====== START ======
async function start() {
    if (!API_KEY) {
        console.warn("TRACKWEAVING_API_KEY is empty. Set it before production use.");
    }

    if (!FTP_PASSWORD) {
        console.warn("FTP_PASSWORD is empty. Set it before production use.");
    }

    if (!TLM_SERVER_HOST) {
        console.warn(
            "TLM_SERVER_HOST is empty. Production data from the TLM main computer will not be fetched."
        );
    }

    app.listen(HTTP_PORT, healthServerStarted);

    setInterval(logHealthSummary, HEALTH_SUMMARY_INTERVAL_MS).unref();

    machineRefreshLoop().catch((error) => {
        console.error("Machine refresh loop failed:", error);
    });

    tlmServerRefreshLoop().catch((error) => {
        console.error("TLM server refresh loop failed:", error);
    });

    dataPushLoop().catch((error) => {
        console.error("Data push loop failed:", error);
    });
}

// ====== SHUTDOWN ======
function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);

    shuttingDown = true;

    for (const control of pollers.values()) {
        control.cancelled = true;
    }

    setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
});

if (require.main === module) {
    start().catch((error) => {
        console.error("Reader startup failed:", error);
        process.exit(1);
    });
}

module.exports = {
    RAW_INDEX,
    STOP_CODE,
    parseStatusCsv,
    parseHeaderedCsv,
    parseTlmServerStatusRow,
    parseTlmServerProductLoomRow,
    parseShiftDataRow,
    SHIFT_DATA_INDEX,
    applyStopTransition,
    stoppedForSeconds,
    resolveLoomNumber
};