// lib/rest.js
const axios = require('axios');

async function callRestApi(conn, method, relativeUrl, payload) {
    const headers = {
        'Authorization': `Bearer ${conn.accessToken}`,
        'Content-Type': 'application/json'
    };

    let response;
    if (method === 'GET') {
        response = await axios.get(`${conn.instanceUrl}${relativeUrl}`, { headers });
    } else if (method === 'POST') {
        response = await axios.post(`${conn.instanceUrl}${relativeUrl}`, payload, { headers });
    } else if (method === 'PATCH') {
        response = await axios.patch(`${conn.instanceUrl}${relativeUrl}`, payload, { headers });
    } else if (method === 'DELETE') {
        response = await axios.delete(`${conn.instanceUrl}${relativeUrl}`, { headers });
    }

    let allData = [];
    let responseData = response.data;

    if (method === 'GET') {
        const getRecordsArray = (data) => {
            for (const key in data) {
                if (Array.isArray(data[key])) {
                    return { key, records: data[key] };
                }
            }
            return { key: null, records: [] };
        };

        let { key: recordsKey, records } = getRecordsArray(responseData);
        if ((responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) && recordsKey) {
            allData = records || [];
            while (responseData.nextPageUrl || (responseData.nextRecordsUrl && !responseData.done)) {
                const nextUrl = responseData.nextPageUrl || responseData.nextRecordsUrl;
                response = await axios.get(`${conn.instanceUrl}${nextUrl}`, { headers });
                responseData = response.data;
                records = responseData[recordsKey] || [];
                allData = allData.concat(records);
            }
        } else {
            allData = Array.isArray(responseData) ? responseData : records.length > 0 ? records : [responseData];
        }
    } else {
        allData = responseData;
    }

    if (method === 'GET' && Array.isArray(allData) && allData.length > 0) {
        const csvWriter = require('csv-writer').createObjectCsvWriter({
            path: 'rest_api_results.csv',
            header: Object.keys(allData[0])
                .filter(key => key !== 'attributes')
                .map(key => ({ id: key, title: key }))
        });
        await csvWriter.writeRecords(allData);
    }

    return allData;
}

module.exports = { callRestApi };