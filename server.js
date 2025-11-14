// index.js
const { default: axios } = require("axios");
const express = require("express");
const ModbusRTU = require("modbus-serial");

const app = express();
const moment = require("moment");

// ====== CONFIG ======
const LOOM_IP = process.env.LOOM_IP || "192.168.205.2";
const LOOM_PORT = parseInt(process.env.LOOM_PORT || "502", 10);
var UNIT_ID = parseInt(process.env.UNIT_ID || "85", 10); // try 1 or 85
const START_ADDR = parseInt(process.env.START_ADDR || "5000", 10);
var COUNT = parseInt(process.env.COUNT || "74", 10);
const ZERO_BASED = true;
const workspaceId = "68de43d477ac61e06d4c9f9f";
var machineData = {};
var REGISTER = {
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
}

// ====== HELPERS ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ====== POLLING LOOP (sequential, no overlaps) ======
async function pollLoop(machine) {
    // simple backoff on errors
    let backoffMs = 1000;

    // ====== STATE ======
    const client = new ModbusRTU();
    let lastError = null;
    let connecting = false;

    // ====== CONNECTION HANDLING ======
    async function connect() {
        if (client.isOpen || connecting) return;
        connecting = true;
        try {
            await client.connectTCP(machine.ip, { port: LOOM_PORT });
            machine.displayType == 'chitic' ? UNIT_ID = 1 : UNIT_ID = 85;
            client.setID(UNIT_ID);
            client.setTimeout(1000);
            lastError = null;
        } catch (e) {
            lastError = e?.message || String(e);
            try { if (client.isOpen) client.close(); } catch { }
        } finally {
            connecting = false;
        }
    }

    // Defensive: mark error on unexpected close/error
    client.on?.("close", () => { /* socket closed */ });
    client.on?.("error", (e) => { lastError = e?.message || String(e); });

    function initMachineData(machineId) {
        machineData[machineId] = {
            displayType: machine.displayType,
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

    function setStopData(machineId, data) {
        let stopDuration = 0;
        if(machineData[machineId].lastStopTime) {
            const stopTime = moment(machineData[machineId].lastStopTime);
            stopDuration = Math.abs(moment().diff(stopTime, 'seconds'));
            if(stopDuration >= 60) {
                machineData[machineId].stopCount += 1;
            }
        }
        if(machine.displayType == 'nazon') {
            switch (machineData[machineId].stop) {
                case 1:
                case 19:
                case 20:
                    machineData[machineId].stopsData.warp.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 2: 
                case 3:
                case 11:
                case 12:
                case 15:
                case 16:
                case 17:
                case 18:
                    machineData[machineId].stopsData.weft.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 7:
                    machineData[machineId].stopsData.feeder.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 4:
                case 6:
                    machineData[machineId].stopsData.manual.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                default:
                    machineData[machineId].stopsData.other.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        duration: stopDuration,
                        statusCode: machineData[machineId].stop
                    })
                    break;
            }
        } else if(machine.displayType == 'chitic') {
            switch (machineData[machineId].stop) {
                case 1:
                    machineData[machineId].stopsData.warp.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 2: 
                case 3:
                case 11:
                case 12:
                    machineData[machineId].stopsData.weft.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 7:
                    machineData[machineId].stopsData.feeder.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                case 4:
                case 6:
                    machineData[machineId].stopsData.manual.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        statusCode: machineData[machineId].stop,
                        duration: stopDuration
                    });
                    break;
    
                default:
                    machineData[machineId].stopsData.other.push({
                        start: machineData[machineId].lastStopTime,
                        end: moment().utc().format(),
                        duration: stopDuration,
                        statusCode: machineData[machineId].stop
                    })
                    break;
            }
        }
    }

    function processData(machineId, deviceType, displayType="nazon", data) {
        const at = (lw) => data[lw - 4999];
        let speed = at(REGISTER[machine.displayType].speed);
        let stop = at(REGISTER[machine.displayType].stop);
        if(machine.displayType == "chitic"){
            if(speed > 5) {
                data[REGISTER[machine.displayType].stop - 4999] = 0;
            }
        }
        if ((!machineData[machineId] && stop != 0) || (machineData[machineId] && machineData[machineId].stop == 0 && stop != 0)) {
            if (!machineData[machineId]) initMachineData(machineId);
            machineData[machineId].lastStopTime = moment().utc().format();
        } else if (!machineData[machineId] && stop == 0) {
            if (!machineData[machineId]) initMachineData(machineId);
            machineData[machineId].lastStartTime = moment().utc().format();
        } else if (machineData[machineId] && machineData[machineId].stop != 0 && stop == 0) {
            machineData[machineId].lastStartTime = moment().utc().format();
            setStopData(machineId, data);
        }
        if(typeof machineData[machineId].shift == "number" && at(REGISTER[machine.displayType].shift) != machineData[machineId].shift) {
            if(machineData[machineId].stop != 0 && stop != 0) {
                setStopData(machineId, data);
                machineData[machineId].lastStopTime = moment().utc().format();
            }
            machineData[machineId].prevData = JSON.parse(JSON.stringify(machineData[machineId]));
            machineData[machineId].stopCount = 0;
            machineData[machineId].stopsData = {
                warp: [],
                weft: [],
                feeder: [],
                manual: [],
                other: []
            };
            if(machineData[machineId].stop == 0 && stop == 0) {
                machineData[machineId].lastStartTime = moment().utc().format();
            }
        }
        machineData[machineId].stop = stop;
        if(deviceType == 'rs485' || displayType == 'chitic') {
            data[REGISTER[machine.displayType].setPicks - 4999] = at(REGISTER[machine.displayType].setPicks) / 10;
        }
        if(displayType == 'chitic') {
            data[REGISTER[machine.displayType].efficiency - 4999] = at(REGISTER[machine.displayType].efficiency);
        }
        machineData[machineId].rawData = data;
        machineData[machineId].shift = at(REGISTER[machine.displayType].shift);
    }
    for (; ;) {
        try {
            if (!client.isOpen) {
                await connect();
            }
            if (client.isOpen) {
                let start = ZERO_BASED ? (START_ADDR - 1) : START_ADDR;
                const resp = await client.readHoldingRegisters(start, COUNT);

                if(resp.data && resp.data.length > 30 && resp.data[REGISTER[machine.displayType].clothLength - start] == 0 && resp.data[REGISTER[machine.displayType].loomState - start] == 0 && resp.data[REGISTER[machine.displayType].speed - start] == 0) {
                    console.log(resp.data);
                } else {
                    processData(machine.id, machine.deviceType, machine.displayType, resp.data);
                }
                lastError = null;
                backoffMs = 1000; // reset backoff on success
            }
        } catch (err) {
            console.log(err)
            lastError = err?.message || String(err);
            try { if (client.isOpen) client.close(); } catch { }
            // increase backoff up to 10s to avoid hammering a dying socket
            backoffMs = Math.min(backoffMs * 2, 10000);
        }

        // Wait either 1s on success or backoff on error
        await sleep(backoffMs);
    }
}

async function initAllMachines() {
    let initData = await axios.post('https://trackweaving.com/api/v1/machine-logs/machine-list', {
        workspaceId: workspaceId,
        apiKey: "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21"
    });
    initData = initData.data;
    for(let machine of initData.data.machines) {
        pollLoop(machine);
    }
    machineData = initData.data.machineData || {};
}

var isDataStorAPICalled = false;

setInterval(async () => {
    try {
        if(isDataStorAPICalled) return;
        isDataStorAPICalled = true;
        await axios.post('https://trackweaving.com/api/v1/machine-logs', {
            logs: machineData,
            workspaceId: workspaceId,
            apiKey: "4d38b5078b4bcd8122e3af614b1239379de1205d85e48808555eb8ca13019f21"
        });
        for(let machineId in machineData) {
            if(machineData[machineId].prevData) {
                machineData[machineId].prevData = null;
            }
        }
        isDataStorAPICalled = false;
    } catch (error) {
        console.log(error);
        isDataStorAPICalled = false;
    }
}, 5000);

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
    console.log(`Loom server on http://localhost:${PORT} started At ${new Date()}`);
    console.log(`Polling ${LOOM_IP}:${LOOM_PORT} (UNIT_ID=${UNIT_ID}) start=${START_ADDR} count=${COUNT} zeroBased=${ZERO_BASED}`);
    initAllMachines();
});

// graceful shutdown
process.on("SIGINT", async () => {
    try { if (client.isOpen) client.close(); } catch { }
    process.exit(0);
});
