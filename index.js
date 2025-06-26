const express = require('express');
const axios = require('axios');
const { google } = require('googleapis'); // Import googleapis library
require('dotenv').config();

const app = express();
const port = 3000;

app.use(express.json());

const path = require('path'); // To resolve path for service account key

// Your external salary API base URL
const EXTERNAL_SALARY_API_BASE_URL = 'https://sleeve-stars-automation-2-32676f7875b4.herokuapp.com/welcome/salaryData';

// --- Google Sheets API Configuration ---
// IMPORTANT: Never hardcode your service account key directly in your code.
// Use environment variables or load from a file securely.
// For demonstration, we'll load from a file, assuming it's in the root of your project
// or a secure 'config' directory.
const SERVICE_ACCOUNT_KEY_PATH = path.join(__dirname, 'linen-rex-462515-s5-1bf5ec6b39e3.json'); // Adjust path as needed
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; // Replace with your actual Google Sheet ID
const RANGE = 'Employee Data!A:D'; // Replace with your sheet name and the column range where IDs are (e.g., 'Sheet1!A:A' for column A)

const REFRESH_TOKEN_API_URL = 'https://sleeve-stars-automation-2-32676f7875b4.herokuapp.com/welcome/refreshToken/request';
const SALARY_DATA_API_BASE_URL = 'https://sleeve-stars-automation-2-32676f7875b4.herokuapp.com/welcome/salaryData';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN;

async function getAccessToken() {
    try {
        console.log('Requesting access token...');
        const response = await axios.post(
            REFRESH_TOKEN_API_URL,
            { refreshToken: REFRESH_TOKEN },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_AUTH_TOKEN}`,
                },
            }
        );
        console.log('Access token response:', response);
        return response.data.accessToken;
    } catch (error) {
        console.error('Error refreshing access token:', error);
        throw new Error('Failed to refresh access token.');
    }
}

/**
 * Function to authenticate with Google Sheets API using a service account.
 */
async function getGoogleSheetsAuth() {
    // Load the service account key from the file
    const credentials = require(SERVICE_ACCOUNT_KEY_PATH);

    const auth = new google.auth.GoogleAuth({
        credentials, // Use the loaded credentials
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return auth.getClient();
}

/**
 * Function to get all employee data from the Google Sheet.
 */
async function getAllEmployeeDataFromSheet() {
    const authClient = await getGoogleSheetsAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            console.log('No data found in Google Sheet.');
            return [];
        }

        // Assuming the first row is a header, so we skip it.
        const headers = rows[0];
        const employeeData = rows.slice(1).map(row => {
            const employee = {};
            headers.forEach((header, index) => {
                employee[header] = row[index];
            });
            return employee;
        });

        return employeeData;
    } catch (err) {
        console.error('The Google Sheets API returned an error: ' + err);
        throw new Error('Failed to retrieve employee data from Google Sheet.');
    }
}

/**
 * Express route to process employee salaries.
 */
app.get('/process', async (req, res) => {
    try {
        // 1. Get all employee data from the Google Sheet
        const allEmployeeData = await getAllEmployeeDataFromSheet();

        if (allEmployeeData.length === 0) {
            return res.status(404).json({ message: 'No employee data found in the Google Sheet.' });
        }

        // 2. Filter active employees
        const activeEmployees = allEmployeeData.filter(employee => employee.isActive === 'TRUE');

        // 3. Get access token
        const accessToken = await getAccessToken();

        // 4. Fetch salary data and create new sheet data
        const newSheetData = await Promise.all(activeEmployees.map(async employee => {
            try {
                const response = await axios({
                    url: `${SALARY_DATA_API_BASE_URL}?empid=${employee.id}`,
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    }
                });
                console.log(`Salary API response for ${employee.id}:`, response.data);
                return {
                    id: employee.id,
                    name: employee.name,
                    position: employee.position,
                    isActive: employee.isActive,
                    salary: response.data.salary
                };
            } catch (error) {
                console.error(`Error fetching salary for ${employee.id}:`, error.message);
                return {
                    id: employee.id,
                    name: employee.name,
                    position: employee.position,
                    isActive: employee.isActive,
                    salary: '0',
                    error: `Failed to fetch salary: ${error.message}`
                };
            }
        }));

        // 5. Create a new sheet and populate it with the processed data
        const sheets = google.sheets({ version: 'v4', auth: await getGoogleSheetsAuth() });

        // Check if the sheet already exists
        let newSheetId = null;
        try {
            const getSheetResponse = await sheets.spreadsheets.get({
                spreadsheetId: SPREADSHEET_ID,
                fields: 'sheets(properties(sheetId,title))'
            });

            const existingSheet = getSheetResponse.data.sheets.find(sheet => sheet.properties.title === 'Employee Salaries');

            if (existingSheet) {
                console.log('Existing sheet found:', existingSheet);
                // Delete the existing sheet
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    requestBody: {
                        requests: [{
                            deleteSheet: {
                                sheetId: existingSheet.properties.sheetId
                            }
                        }]
                    }
                });
            }

            // Add the new sheet
            const addSheetResponse = await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: 'Employee Salaries'
                            }
                        }
                    }]
                }
            });

            newSheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;
        } catch (error) {
            console.error('Error creating or deleting sheet:', error);
            throw new Error('Failed to create or delete sheet.');
        }

        const headerValues = ['id', 'name', 'position', 'isActive', 'salary'];
        const data = [headerValues, ...newSheetData.map(item => [item.id, item.name, item.position, item.isActive, item.salary])];

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'Employee Salaries'!A1:E${data.length}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: data
            }
        });

        // 6. Respond to the client
        res.status(200).json({
            message: 'Employee salary processing complete',
            salaries: newSheetData
        });

    } catch (error) {
        console.error('Error in /process route:', error);
        res.status(500).json({
            message: 'An error occurred while processing employee salaries',
            error: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
