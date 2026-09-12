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

const FTP_PORT = toInteger(process.env.FTP_PORT, 21);
const FTP_USERNAME = process.env.FTP_USERNAME || "anonymous";
const FTP_PASSWORD = process.env.FTP_PASSWORD || "aaatccs@";
const FTP_SECURE = /^true$/i.test(process.env.FTP_SECURE || "false");

const FTP_TIMEOUT_MS = toInteger(process.env.FTP_TIMEOUT_MS, 7000);
const FTP_FILE_RETRY_COUNT = toInteger(process.env.FTP_FILE_RETRY_COUNT, 2);
const FTP_FILE_RETRY_DELAY_MS = toInteger(process.env.FTP_FILE_RETRY_DELAY_MS, 250);

const POLL_INTERVAL_MS = toInteger(process.env.POLL_INTERVAL_MS, 5000);
const PRODUCTION_POLL_INTERVAL_MS = toInteger(process.env.PRODUCTION_POLL_INTERVAL_MS, 40000);
const TISS_POLL_INTERVAL_MS = toInteger(process.env.TISS_POLL_INTERVAL_MS, 60000);
const AUTO_POLL_INTERVAL_MS = toInteger(process.env.AUTO_POLL_INTERVAL_MS, 3600000);
const EVENT_POLL_INTERVAL_MS = toInteger(process.env.EVENT_POLL_INTERVAL_MS, 300000);

const MACHINE_REFRESH_MS = toInteger(process.env.MACHINE_REFRESH_MS, 300000);
const DATA_PUSH_INTERVAL_MS = toInteger(process.env.DATA_PUSH_INTERVAL_MS, 5000);
const POWER_OFF_AFTER_MS = toInteger(process.env.POWER_OFF_AFTER_MS, 90000);
const MAX_CONCURRENT_FTP = toInteger(process.env.MAX_CONCURRENT_FTP, 16);
const MAX_FAILURE_BACKOFF_MS = toInteger(process.env.MAX_FAILURE_BACKOFF_MS, 15000);
const MIN_COUNTED_STOP_SECONDS = toInteger(process.env.MIN_COUNTED_STOP_SECONDS, 0);

const LOOM_UTC_OFFSET = process.env.LOOM_UTC_OFFSET || "+05:30";
const HTTP_PORT = toInteger(process.env.PORT, 3001);
const MACHINE_CACHE_FILE = process.env.MACHINE_CACHE_FILE || path.join(path.dirname(process.execPath), "tsudakoma-machine-cache.json");
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
const pollers = new Map();
let shuttingDown = false;
let machineApiOffline = false;
let dataPushOffline = false;
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

function round(value, decimals) {
    if (!Number.isFinite(value)) return 0;

    const decimalPlaces = decimals === undefined ? 1 : decimals;
    const factor = 10 ** decimalPlaces;

    return Math.round(value * factor) / factor;
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

function ftpCredentials(machine) {
    return {
        user: machine.ftpUsername || machine.ftpUser || FTP_USERNAME,
        password: machine.ftpPassword || FTP_PASSWORD
    };
}

// ====== READ LOOM FILES ======
async function readLoomFiles(machine, options) {
    async function readFiles() {
        const client = new ftp.Client(FTP_TIMEOUT_MS);
        client.prepareTransfer = ftp.enterPassiveModeIPv4;
        client.ftp.verbose = /^true$/i.test(process.env.FTP_VERBOSE || "false");

        const credentials = ftpCredentials(machine);
        const loomNo = resolveLoomNumber(machine);

        const readOptions = options && typeof options === "object"
            ? options
            : {
                includeProduction: true,
                includeTiss: true,
                includeAuto: true,
                includeEvents: Boolean(options)
            };

        const files = {};
        const startedAt = Date.now();

        try {
            await client.access({
                host: machine.ip,
                port: toInteger(machine.ftpPort, FTP_PORT),
                user: credentials.user,
                password: credentials.password,
                secure: FTP_SECURE
            });

            // Live status is mandatory.
            files.status = await downloadTextWithRetry(client, "I_STATUS.CSV");

            if (readOptions.includeProduction) {
                try {
                    files.shiftProduction = await downloadTextWithRetry(client, "I_SHIFTPRD.CSV");
                } catch (error) {
                    files.shiftProductionError = error && error.message ? error.message : String(error);
                }
            }

            if (readOptions.includeTiss) {
                try {
                    files.tissStatus = await downloadTextWithRetry(client, `${loomNo}_I_TISS_STATUS.CSV`);
                } catch (error) {
                    files.tissStatusError = error && error.message ? error.message : String(error);
                }
            }

            if (readOptions.includeAuto) {
                try {
                    files.autoSettings = await downloadTextWithRetry(client, "I_AUTO.CSV");
                    files.autoSettingsError = null;
                } catch (error) {
                    files.autoSettingsError = error && error.message ? error.message : String(error);
                }
            }

            if (readOptions.includeEvents) {
                try {
                    files.shiftEvents = await downloadTextWithRetry(client, "I_SHIFTEVT.CSV");
                } catch (error) {
                    files.shiftEventsError = error && error.message ? error.message : String(error);
                }
            }

            return {
                files,
                loomNo,
                readDurationMs: Date.now() - startedAt
            };
        } finally {
            client.close();
        }
    }

    const queueStartedAt = Date.now();
    const result = await ftpSemaphore.use(readFiles);

    result.queueWaitMs = Math.max(0, Date.now() - queueStartedAt - result.readDurationMs);

    return result;
}

// ====== PARSERS ======
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

function parseShiftProductionCsv(text) {
    const rows = parseCsvRows(text);

    if (!rows.length) throw new Error("I_SHIFTPRD.CSV is empty");

    const row = rows[rows.length - 1];

    if (row.length < 20) throw new Error("I_SHIFTPRD.CSV current row is incomplete");

    const rpm = toNumber(row[6]);
    const elapsedMinutes = toNumber(row[7]) / 10;
    const availableMinutes = toNumber(row[8]) / 10;
    const runtimeMinutes = toNumber(row[8]) / 10;
    const productionMeter = toNumber(row[10]) / 10;
    const unavailableMinutes = toNumber(row[11]) / 10;
    const totalStopCount = toInteger(row[15]);

    const millEfficiency = elapsedMinutes > 0
        ? (availableMinutes / elapsedMinutes) * 100
        : toNumber(row[19]) / 10;

    const loomEfficiency = toNumber(row[19]) / 10;
    const calculatedShiftPicks = Math.max(0, Math.round(toNumber(row[9]) * 100));

    return {
        shiftDate: String(row[0]).trim(),
        shift: toSystemShift(row[1]),
        sourceDate: String(row[3]).trim(),
        sourceTime: String(row[4]).trim(),
        sourceTimestamp: loomDateTimeToUtc(row[3], row[4]),
        styleNo: String(row[5] || "").trim(),
        rpm,
        elapsedMinutes: round(elapsedMinutes, 1),
        availableMinutes: round(availableMinutes, 1),
        runtimeMinutes: round(runtimeMinutes, 1),
        productionMeter: round(productionMeter, 1),
        unavailableMinutes: round(unavailableMinutes, 1),
        millEfficiency: round(millEfficiency, 1),
        loomEfficiency: round(loomEfficiency, 1),
        calculatedShiftPicks,
        totalStopCount,
        raw: row
    };
}

function parseTissStatusCsv(text) {
    if (!text) return null;

    const rows = parseCsvRows(text);

    if (!rows.length || rows[0].length < 16) return null;

    const row = rows[0];

    return {
        sourceDate: String(row[0]).trim(),
        sourceTime: String(row[1]).trim(),
        sourceTimestamp: loomDateTimeToUtc(row[0], row[1]),
        assumedCurrentOrSetRpm: toNumber(row[5]) / 10,
        assumedWeftDensity: toNumber(row[15]) / 10,
        raw: row
    };
}

function parseAutoSettingsCsv(text) {
    if (!text) return null;

    const rows = parseCsvRows(text);

    if (rows.length <= 2732) return null;

    const densityRaw = toNumber(rows[2732][0]);

    return {
        densityRaw,
        weftDensity: densityRaw / 10
    };
}

// ====== STOP CODES ======
const STOP_CODE = Object.freeze({
    20: { reason: "H1 feeler C1", bucket: "h1", group: "filling" },
    21: { reason: "H1 feeler C2", bucket: "h1", group: "filling" },
    25: { reason: "H2 feeler C1", bucket: "h2", group: "filling" },
    26: { reason: "H2 feeler C2", bucket: "h2", group: "filling" },
    31: { reason: "Dropper", bucket: "warp", group: "warp" },
    41: { reason: "Leno left", bucket: "other", group: "other" },
    42: { reason: "Leno right", bucket: "other", group: "other" },
    43: { reason: "CC", bucket: "warp", group: "warp" },
    50: { reason: "Package sensor C1", bucket: "h1", group: "h1" },
    51: { reason: "Package sensor C2", bucket: "h1", group: "h1" },
    71: { reason: "Counter", bucket: "other", group: "other" },
    11: { reason: "Stop button", bucket: "manual", group: "other" }
});

function stopDefinition(code) {
    return STOP_CODE[code] || {
        reason: `Tsudakoma stop ${code}`,
        bucket: "other",
        group: "other"
    };
}

// ====== EVENTS ======
function parseCurrentShiftEvents(text) {
    if (!text) return null;

    const rows = parseCsvRows(text);

    if (!rows.length) return null;

    const row = rows[rows.length - 1];
    const shiftDate = String(row[0]).trim();
    const shift = toSystemShift(row[1]);
    const events = [];

    for (let index = 5; index + 10 < row.length; index += 11) {
        const group = row.slice(index, index + 11);
        const code = toInteger(group[4]);

        if (code <= 0) continue;

        const start = loomDateTimeToUtc(group[0], group[1]);
        const durationSeconds = Math.max(0, Math.round(toNumber(group[8]) * 6));

        if (!start || durationSeconds < MIN_COUNTED_STOP_SECONDS) continue;

        const definition = stopDefinition(code);

        events.push({
            start,
            end: moment.utc(start).add(durationSeconds, "seconds").format(),
            statusCode: code,
            duration: durationSeconds,
            reason: definition.reason,
            group: definition.group,
            bucket: definition.bucket,
            doffNo: toInteger(group[2]),
            clothLengthMeter: toNumber(group[3]) / 10,
            eventKey: `${start}|${code}|${group[2]}|${group[3]}`
        });
    }

    return { shiftDate, shift, events, raw: row };
}

function buildStopsData(events) {
    const stopsData = blankStopsData();

    for (const event of events) {
        const bucket = stopsData[event.bucket] ? event.bucket : "other";

        stopsData[bucket].push({
            start: event.start,
            end: event.end,
            statusCode: event.statusCode,
            duration: event.duration,
            reason: event.reason,
            doffNo: event.doffNo,
            clothLengthMeter: event.clothLengthMeter
        });
    }

    return stopsData;
}

function summarizeStops(events) {
    const summary = {
        total: { count: 0, durationSeconds: 0 },
        filling: { count: 0, durationSeconds: 0 },
        warp: { count: 0, durationSeconds: 0 },
        other: { count: 0, durationSeconds: 0 },
        byCode: {}
    };

    for (const event of events) {
        summary.total.count += 1;
        summary.total.durationSeconds += event.duration;

        const group = summary[event.group] ? event.group : "other";

        summary[group].count += 1;
        summary[group].durationSeconds += event.duration;

        const key = String(event.statusCode);

        if (!summary.byCode[key]) {
            summary.byCode[key] = {
                code: event.statusCode,
                reason: event.reason,
                count: 0,
                durationSeconds: 0
            };
        }

        summary.byCode[key].count += 1;
        summary.byCode[key].durationSeconds += event.duration;
    }

    return summary;
}

// ====== STOP PROCESSING ======
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

function aggregateStopBucket(stopsData, bucketNames) {
    const entries = bucketNames.flatMap((name) => stopsData[name] || []);
    const durationSeconds = entries.reduce((total, entry) => total + (entry.duration || 0), 0);

    return {
        count: entries.length,
        durationSeconds
    };
}

function buildNormalizedRawData(values, stopsData) {
    const data = Array(Object.keys(RAW_INDEX).length).fill(0);

    const warp = aggregateStopBucket(stopsData, ["warp"]);
    const h1 = aggregateStopBucket(stopsData, ["h1"]);
    const h2 = aggregateStopBucket(stopsData, ["h2", "feeder"]);
    const other = aggregateStopBucket(stopsData, ["other", "manual"]);

    data[RAW_INDEX.shift] = values.shift;
    data[RAW_INDEX.quality] = values.quality;
    data[RAW_INDEX.stopCode] = values.currentStop;
    data[RAW_INDEX.runTime] = values.runtimeMinutes;
    data[RAW_INDEX.efficiencyPercent] = values.loomEfficiency;
    data[RAW_INDEX.currentDensity] = values.weftDensity;
    data[RAW_INDEX.pieceLengthM] = values.productionMeter;
    data[RAW_INDEX.picksCurrentShift] = values.currentShiftPicks;
    data[RAW_INDEX.beamLeft] = values.beamLeftMeter;
    data[RAW_INDEX.initialBeamLeft] = values.beamOriginalMeter;
    data[RAW_INDEX.beamCompletionDate] = values.beamCompletionDatetime;
    data[RAW_INDEX.warpStopCount] = warp.count;
    data[RAW_INDEX.warpStopDuration] = warp.durationSeconds / 60;
    data[RAW_INDEX.h1StopCount] = h1.count;
    data[RAW_INDEX.h1StopDuration] = h1.durationSeconds / 60;
    data[RAW_INDEX.h2StopCount] = h2.count;
    data[RAW_INDEX.h2StopDuration] = h2.durationSeconds / 60;
    data[RAW_INDEX.otherStopCount] = other.count;
    data[RAW_INDEX.otherStopDuration] = other.durationSeconds / 60;
    data[RAW_INDEX.speedRpm] = values.currentRpm;

    return data;
}

// ====== MACHINE PROCESSING ======
function processLoomData(machine, result, fetchedAt) {
    const machineId = String(machine.id);
    const state = ensureMachineData(machine);
    const status = parseStatusCsv(result.files.status);

    let production = null;
    let tiss = null;
    let autoSettings = null;
    let events = null;

    if (result.files.shiftProduction) {
        production = parseShiftProductionCsv(result.files.shiftProduction);
        state.cachedProduction = production;
    } else {
        production = state.cachedProduction || null;
    }

    if (result.files.tissStatus) {
        tiss = parseTissStatusCsv(result.files.tissStatus);

        if (tiss) {
            state.cachedTissStatus = tiss;
        }
    } else {
        tiss = state.cachedTissStatus || null;
    }

    if (result.files.autoSettings) {
        autoSettings = parseAutoSettingsCsv(result.files.autoSettings);

        if (autoSettings) {
            state.cachedAutoSettings = autoSettings;
        }
    } else {
        autoSettings = state.cachedAutoSettings || null;
    }

    if (result.files.shiftEvents) {
        events = parseCurrentShiftEvents(result.files.shiftEvents);

        if (events) {
            state.cachedEvents = events;
        }
    }

    const previousShift = state.shift;

    const currentShift = production
        ? production.shift
        : Number.isFinite(previousShift)
        ? previousShift
        : 0;

    if (
        production &&
        Number.isFinite(previousShift) &&
        previousShift !== production.shift
    ) {
        state.prevData = JSON.parse(JSON.stringify(state));
        state.stopCount = 0;
        state.totalStopCount = 0;
        state.stopsData = blankStopsData();
        state.stopSummary = summarizeStops([]);
        state.cachedEvents = null;
    }

    /*
     * IMPORTANT:
     * Use fetchedAt for LIVE stop transitions.
     * Do not use an old Tsudakoma source timestamp here.
     */
    applyStopTransition(state, status.currentStop, fetchedAt);

    if (events && events.shift === currentShift) {
        state.stopsData = buildStopsData(events.events);
        state.stopSummary = summarizeStops(events.events);
        state.stopCount = events.events.length;

        state.totalStopCount = production && production.totalStopCount
            ? production.totalStopCount
            : events.events.length;

        state.lastEventSyncAt = fetchedAt;

        /*
         * Do NOT overwrite lastStopTime by finding an old event
         * having the same stop code.
         */
    } else if (production) {
        state.totalStopCount = production.totalStopCount;
    }

    const averageRpm = production
        ? production.rpm
        : toNumber(state.averageRpm);

    const assumedCurrentRpm = tiss && tiss.assumedCurrentOrSetRpm
        ? tiss.assumedCurrentOrSetRpm
        : averageRpm;

    const currentRpm = status.runFlag === 1 ? assumedCurrentRpm : 0;

    const tissDensity = tiss && tiss.assumedWeftDensity
        ? tiss.assumedWeftDensity
        : 0;

    const autoDensity = autoSettings && autoSettings.weftDensity
        ? autoSettings.weftDensity
        : 0;

    const configuredDensity =
        toNumber(machine.setPicks) ||
        toNumber(machine.currentDensity) ||
        toNumber(machine.weftDensity) ||
        toNumber(state.weftDensity);

    const weftDensity = tissDensity || autoDensity || configuredDensity;

    const calculatedShiftPicks = production
        ? production.calculatedShiftPicks
        : toNumber(state.currentShiftPicks);

    const currentShiftPicks = status.directClothPicks > 0
        ? Math.round(status.directClothPicks)
        : calculatedShiftPicks;

    const beamCompletionDatetime = status.beamRemainingHours > 0
        ? moment.utc(fetchedAt).add(status.beamRemainingHours, "hours").format()
        : null;

    const runtimeMinutes = production
        ? production.runtimeMinutes
        : toNumber(state.runtimeMinutes || state.runtime);

    const millEfficiency = production
        ? production.millEfficiency
        : toNumber(state.millEfficiency || state.efficiency);

    const loomEfficiency = production
        ? production.loomEfficiency
        : toNumber(state.loomEfficiency || state.efficiency);

    const productionMeter = production
        ? production.productionMeter
        : toNumber(state.productionMeter);

    const styleNo = production
        ? production.styleNo
        : state.quality || "";

    const totalStopCount = production
        ? production.totalStopCount
        : toInteger(state.totalStopCount);

    const normalized = {
        loomNo: result.loomNo,
        shift: currentShift,
        quality: styleNo,
        currentStop: status.currentStop,
        currentStopReason: status.currentStop ? stopDefinition(status.currentStop).reason : null,
        runFlag: status.runFlag,
        runtimeMinutes,
        millEfficiency,
        loomEfficiency,
        efficiency: loomEfficiency,
        averageRpm,
        currentRpm,
        productionMeter,
        currentPieceMeter: status.currentPieceMeter,
        currentShiftPicks,
        beamOriginalMeter: status.beamOriginalMeter,
        beamConsumedMeter: status.beamConsumedMeter,
        beamLeftMeter: status.beamLeftMeter,
        beamRemainingHours: status.beamRemainingHours,
        beamCompletionDatetime,
        weftDensity,
        totalStopCount,
        doffNo: status.doffNo
    };

    state.updatedTime = fetchedAt;
    state.lastSuccessfulReadAt = fetchedAt;
    state.lastStatusSourceTimestamp = status.sourceTimestamp || null;
    state.firstConnectionFailureAt = null;
    state.isPowerOff = false;
    state.readError = null;

    state.shift = currentShift;
    state.quality = normalized.quality;
    state.speed = normalized.currentRpm;
    state.averageRpm = normalized.averageRpm;
    state.runtime = normalized.runtimeMinutes;
    state.runtimeMinutes = normalized.runtimeMinutes;
    state.efficiency = normalized.efficiency;
    state.millEfficiency = normalized.millEfficiency;
    state.loomEfficiency = normalized.loomEfficiency;
    state.productionMeter = normalized.productionMeter;
    state.currentShiftPicks = normalized.currentShiftPicks;
    state.beamLeftMeter = normalized.beamLeftMeter;
    state.beamCompletionDatetime = normalized.beamCompletionDatetime;
    state.weftDensity = normalized.weftDensity;
    state.currentPieceMeter = normalized.currentPieceMeter;
    state.doffNo = normalized.doffNo;
    state.currentStopReason = normalized.currentStopReason;

    state.rawData = buildNormalizedRawData(normalized, state.stopsData);

    state.source = {
        loomStatusTimestamp: status.sourceTimestamp,
        shiftProductionTimestamp: production && production.sourceTimestamp
            ? production.sourceTimestamp
            : null,
        tissStatusTimestamp: tiss && tiss.sourceTimestamp
            ? tiss.sourceTimestamp
            : null,
        collectedAt: fetchedAt,
        ftpIp: machine.ip,
        loomNo: result.loomNo,
        provisionalFields: {
            currentRpm: "TISS status field 6 / 10",
            weftDensity: "TISS status field 16 / 10"
        }
    };

    state.tsudakomaRaw = {
        status: status.raw,
        shiftProduction: production && production.raw ? production.raw : null,
        tissStatus: tiss && tiss.raw ? tiss.raw : null
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
        state.speed = 0;

        if (Array.isArray(state.rawData)) {
            state.rawData[RAW_INDEX.stopCode] = POWER_OFF_STOP_CODE;
            state.rawData[RAW_INDEX.speedRpm] = 0;
        }

        state.updatedTime = now;

        console.log(
            `[${now}] Machine offline/power-off: ${machine.ip}, offline=${Math.round(offlineForMs / 1000)}s`
        );
    }
}

// ====== POLLING ======
async function pollLoop(machine, control, initialDelayMs) {
    const machineId = String(machine.id);

    await sleep(initialDelayMs);

    let lastProductionPollAt = 0;
    let lastTissPollAt = 0;
    let lastAutoPollAt = 0;
    let lastEventPollAt = 0;
    let backoffMs = POLL_INTERVAL_MS;

    while (!shuttingDown && !control.cancelled) {
        const startedAt = Date.now();

        try {
            const includeProduction =
                !lastProductionPollAt ||
                startedAt - lastProductionPollAt >= PRODUCTION_POLL_INTERVAL_MS;

            const includeTiss =
                !lastTissPollAt ||
                startedAt - lastTissPollAt >= TISS_POLL_INTERVAL_MS;

            const includeAuto =
                !lastAutoPollAt ||
                startedAt - lastAutoPollAt >= AUTO_POLL_INTERVAL_MS;

            const includeEvents =
                !lastEventPollAt ||
                startedAt - lastEventPollAt >= EVENT_POLL_INTERVAL_MS;

            const result = await readLoomFiles(control.machine, {
                includeProduction,
                includeTiss,
                includeAuto,
                includeEvents
            });

            const fetchedAt = utcNow();

            processLoomData(control.machine, result, fetchedAt);

            if (includeProduction) lastProductionPollAt = startedAt;
            if (includeTiss) lastTissPollAt = startedAt;
            if (includeAuto) lastAutoPollAt = startedAt;
            if (includeEvents) lastEventPollAt = startedAt;

            backoffMs = POLL_INTERVAL_MS;

            const state = machineData[machineId];

            healthStats.ftpReads += 1;
            healthStats.totalReadMs += result.readDurationMs;
            healthStats.totalQueueMs += result.queueWaitMs;

            if (result.readDurationMs > healthStats.maxReadMs) {
                healthStats.maxReadMs = result.readDurationMs;
            }

            if (result.queueWaitMs > healthStats.maxQueueMs) {
                healthStats.maxQueueMs = result.queueWaitMs;
            }

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

            if (result.files.shiftProductionError && !isExpectedOptionalFileError(result.files.shiftProductionError)) {
                console.warn(
                    `[${fetchedAt}] ${control.machine.ip} I_SHIFTPRD.CSV skipped: ${result.files.shiftProductionError}`
                );
            }

            if (result.files.tissStatusError && !isExpectedOptionalFileError(result.files.tissStatusError)) {
                console.warn(
                    `[${fetchedAt}] ${control.machine.ip} TISS status skipped: ${result.files.tissStatusError}`
                );
            }

            if (result.files.autoSettingsError && !isExpectedOptionalFileError(result.files.autoSettingsError)) {
                console.warn(
                    `[${fetchedAt}] ${control.machine.ip} I_AUTO.CSV skipped: ${result.files.autoSettingsError}`
                );
            }

            if (result.files.shiftEventsError && !isExpectedOptionalFileError(result.files.shiftEventsError)) {
                console.warn(
                    `[${fetchedAt}] ${control.machine.ip} I_SHIFTEVT.CSV skipped: ${result.files.shiftEventsError}`
                );
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
                Math.max(POLL_INTERVAL_MS, Math.round(backoffMs * 1.5)),
                MAX_FAILURE_BACKOFF_MS
            );
        }

        const elapsed = Date.now() - startedAt;
        const jitter = Math.floor(Math.random() * 500);

        await sleep(Math.max(500, backoffMs - elapsed) + jitter);
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

    const initialDelayMs = index * 100;

    pollLoop(machine, control, initialDelayMs).catch((error) => {
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

function applyMachineConfiguration(initData, source) {
    const serverMachineData = initData.machineData || {};

    for (const [machineId, data] of Object.entries(serverMachineData)) {
        if (!machineData[machineId]) {
            machineData[machineId] = data;
        }
    }

    const machines = (initData.machines || []).filter(isTsudakomaMachine);
    const activeIds = new Set(machines.map((machine) => String(machine.id)));

    machines.forEach((machine, index) => {
        startOrUpdatePoller(machine, index);
    });

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
        const cachedCount = applyMachineConfiguration(cached.data, "local cache");
        console.log(`[${utcNow()}] Loaded ${cachedCount} Tsudakoma machines from local cache.`);
    }

    let retryMs = 10000;
    let loggedTrackWeavingLoad = false;

    while (!shuttingDown) {
        try {
            const initData = await fetchMachines();
            const machineCount = applyMachineConfiguration(initData, "TrackWeaving");
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

            for (const [machineId, data] of Object.entries(machineData)) {
                if (
                    data.updatedTime &&
                    moment.utc().diff(moment.utc(data.updatedTime), "hours") < 1
                ) {
                    dataToSend[machineId] = {
                        displayType: data.displayType,
                        lastStopTime: data.lastStopTime,
                        lastStartTime: data.lastStartTime,
                        prevData: data.prevData,
                        stopCount: data.stopCount,
                        stopsData: data.stopsData,
                        stop: data.stop,
                        powerOff: data.isPowerOff,
                        rawData: data.rawData,
                        shift: data.shift
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

                for (const machineId of Object.keys(dataToSend)) {
                    if (machineData[machineId] && machineData[machineId].prevData) {
                        machineData[machineId].prevData = null;
                    }
                }

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

    for (const data of Object.values(machineData)) {
        if (data.isPowerOff) powerOff += 1;
        if (data.readError) readErrors += 1;
    }

    const reads = healthStats.ftpReads;
    const avgRead = reads ? Math.round(healthStats.totalReadMs / reads) : 0;
    const avgQueue = reads ? Math.round(healthStats.totalQueueMs / reads) : 0;

    console.log(
        `[${utcNow()}] HEALTH machines=${pollers.size}` +
        ` powerOff=${powerOff}` +
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
        ` dataApi=${dataPushOffline ? "DOWN" : "OK"}`
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
    const machines = Object.entries(machineData).map(([id, data]) => ({
        id,
        updatedTime: data.updatedTime || null,
        stop: data.stop,
        isPowerOff: Boolean(data.isPowerOff),
        readError: data.readError || null
    }));

    res.json({
        ok: true,
        time: utcNow(),
        machineCount: machines.length,
        activePollers: pollers.size,
        machineApiOnline: !machineApiOffline,
        dataApiOnline: !dataPushOffline,
        machines
    });
}

app.get("/health", healthHandler);

function healthServerStarted() {
    console.log(`Tsudakoma reader health server: http://localhost:${HTTP_PORT}/health`);

    console.log(
        `FTP status every ${POLL_INTERVAL_MS}ms, ` +
        `production ${PRODUCTION_POLL_INTERVAL_MS}ms, ` +
        `TISS ${TISS_POLL_INTERVAL_MS}ms, ` +
        `events ${EVENT_POLL_INTERVAL_MS}ms, ` +
        `max FTP sessions ${MAX_CONCURRENT_FTP}`
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

    app.listen(HTTP_PORT, healthServerStarted);

    setInterval(logHealthSummary, HEALTH_SUMMARY_INTERVAL_MS).unref();

    machineRefreshLoop().catch((error) => {
        console.error("Machine refresh loop failed:", error);
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
    parseShiftProductionCsv,
    parseTissStatusCsv,
    parseAutoSettingsCsv,
    parseCurrentShiftEvents,
    buildStopsData,
    summarizeStops,
    processLoomData,
    resolveLoomNumber
};