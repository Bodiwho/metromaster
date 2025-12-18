document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const PRIMARY_APP_ID = '00ebfbd8';
    const PRIMARY_APP_KEY = '106da0e97d453028e6751b44e675f208';
    const API_BASE_URL = 'https://api.tmb.cat/v1/itransit/metro/estacions';
    const FALLBACK_APP_ID = '4c132798';
    const FALLBACK_APP_KEY = '8504ae3a636b155724a1c7e140ee039f';
    const FALLBACK_API_URL = 'https://api.tmb.cat/v1/transit/core/horaris/';
    const STATIONS_CSV_PATH = 'estacions_linia.csv';

    // --- DOM Elements ---
    const stationSelect = document.getElementById('station-select');
    const resultsContainer = document.getElementById('results-container');
    const errorMessageDiv = document.getElementById('error-message');
    const timestampContainer = document.getElementById('timestamp-container');

    // --- State Management ---
    let autoRefreshIntervalId = null; // To hold the interval ID for auto-refreshing
    let countdownIntervalIds = []; // To hold all active countdown interval IDs
    let choicesInstance = null; // To hold the Choices.js instance
    let abortController = null; // To handle cancellation of fetch requests

    /**
     * A robust CSV parser that handles quoted fields containing commas.
     * @param {string} line - A single line from the CSV file.
     * @returns {string[]} An array of column values.
     */
    function parseCsvLine(line) {
        const columns = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                columns.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        columns.push(current);
        return columns;
    }

    /**
     * A utility to safely trim strings, returning an empty string for null/undefined input.
     * @param {string | null | undefined} str - The string to trim.
     */
    const safeTrim = (str) => str?.trim() ?? '';
    /**
     * Loads stations from the CSV file and populates the dropdown menu.
     * Assumes CSV format: FID,ID_ESTACIO,CODI_GRUP_ESTACIO,NOM_ESTACIO,...
     */
    async function loadStations() {
        console.log("Attempting to load stations from CSV...");
        try {
            const response = await fetch(STATIONS_CSV_PATH);
            if (!response.ok) {
                throw new Error(`Could not load the stations file: ${response.statusText}`);
            }
            const csvText = await response.text();

            // Use a map to group lines by station name, ensuring each station appears only once.
            const stationsMap = new Map();
            csvText.split('\n').slice(1).forEach(line => {
                if (!line) return; // Skip empty lines

                const columns = parseCsvLine(line);
                const stationName = safeTrim(columns[7]); // NOM_ESTACIO
                const lineSpecificCode = safeTrim(columns[6]); // CODI_ESTACIO
                const lineName = safeTrim(columns[11]); // NOM_LINIA

                if (!stationName || !lineSpecificCode || !lineName) return;

                if (stationsMap.has(stationName)) {
                    // If station already exists, just add the new line to its list
                    const stationData = stationsMap.get(stationName);
                    stationData.lines.add(lineName);
                    stationData.apiCodes.add(lineSpecificCode); // Add the line-specific code to the set
                } else {
                    // If it's a new station, create its entry
                    stationsMap.set(stationName, {
                        name: stationName,
                        apiCodes: new Set([lineSpecificCode]), // Use a Set for unique API codes
                        lines: new Set([lineName]) // Use a Set for unique lines
                    });
                }
            });

            // --- DEBUG LOG ---
            // Log the final grouped station data to the console for verification.
            console.log("--- Station Grouping Report ---");
            stationsMap.forEach((stationData, stationName) => {
                console.log(`Station: "${stationName}" | API Codes: [${Array.from(stationData.apiCodes).join(', ')}] | Lines: [${Array.from(stationData.lines).join(', ')}]`);
            });
            console.log("---------------------------------");

            const stations = Array.from(stationsMap.values())
                .map(station => ({ ...station, apiCodes: Array.from(station.apiCodes), lines: Array.from(station.lines).sort() })) // Convert Sets to Arrays
                .sort((a, b) => a.name.localeCompare(b.name));

            // Create the list of choices for the library before initializing
            const choices = stations.map(station => ({
                value: station.name, // Use the station name as the unique value
                label: station.name, // The text displayed in the dropdown
                customProperties: { apiCodes: station.apiCodes, lines: station.lines } // Store all API codes and lines
            }));

            // Initialize Choices.js with the choices data
            choicesInstance = new Choices(stationSelect, {
                choices: choices, // Pass the choices here
                searchEnabled: true,
                itemSelectText: '',
                shouldSort: false, // We have already sorted the list
                placeholder: true,
                placeholderValue: '-- Choose a station --',
            });
            console.log("Stations loaded and Choices.js initialized successfully.");
        } catch (error) {
            console.error("ERROR in loadStations:", error);
            showError("Could not load stations. Please refresh the page to try again.");
        }
    }

    /**
     * Fetches and displays data for a station from the API.
     */
    async function fetchStationData() {
        // Guard clause: If choicesInstance is null, it means station loading failed.
        if (!choicesInstance) {
            console.error("Cannot fetch data: Choices.js instance is not available.");
            return;
        }

        const selectedItem = choicesInstance.getValue(); // This gets the full item object
        // Note: choicesInstance.getValue(true) would just return the station code string
        const stationApiCodes = selectedItem?.customProperties?.apiCodes; // This is correct
        if (!stationApiCodes || stationApiCodes.length === 0) {
            showError("Please select a station.");
            return;
        }

        // Stop any previous auto-refresh and countdown timers
        if (autoRefreshIntervalId) clearInterval(autoRefreshIntervalId);
        clearCountdownTimers();
        
        // Abort any ongoing fetch request before starting a new one
        if (abortController) abortController.abort();
        abortController = new AbortController();

        // Clear previous results and show loading state
        errorMessageDiv.textContent = '';
        resultsContainer.innerHTML = '<p>Loading train data...</p>'; // Add a loading indicator

        try {
            // --- DEBUG LOG ---
            console.log(`[API] Station "${selectedItem.value}" has these API codes: [${stationApiCodes.join(', ')}]. Fetching data for all.`);

            // Create an array of fetch promises, one for each group code
            const fetchPromises = stationApiCodes.map(code => {
                const apiUrl = `${API_BASE_URL}?estacions=${code}&app_id=${PRIMARY_APP_ID}&app_key=${PRIMARY_APP_KEY}`;
                console.log(`[API] Fetching from: ${apiUrl}`);
                return fetch(apiUrl, { signal: abortController.signal }).then(res => {
                    if (!res.ok) throw new Error(`API Error for station ID ${code}: ${res.statusText}`);
                    return res.json();
                });
            });

            // Wait for all API calls to complete
            const allResponses = await Promise.all(fetchPromises);

            // Merge the 'linies' arrays from all responses into one single data object
            const mergedData = allResponses.reduce((acc, current) => {
                if (current.linies) {
                    acc.linies = (acc.linies || []).concat(current.linies);
                }
                return acc;
            }, {});

            resultsContainer.innerHTML = ''; // Clear results only on successful fetch
            displayResults(mergedData, selectedItem.customProperties.lines, stationApiCodes);
            updateTimestamp();

            // Start auto-refreshing every 30 seconds
            autoRefreshIntervalId = setInterval(fetchStationData, 30000);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Fetch aborted by new request.');
                return; // Don't show an error if the fetch was intentionally aborted
            }
            console.error("ERROR in fetchStationData:", error);
            showError("Could not get information. Please try again later.");
        }
    }

    /**
     * Displays the results from the API on the page.
     * @param {object} apiData - The response object from the API.
     * @param {string[]} allStationLines - An array of all lines for the station, e.g., ['L1', 'L4'].
     * @param {string[]} stationApiCodes - An array of API codes used for the station.
     */
    function displayResults(apiData, allStationLines, stationApiCodes) {
        // Clear any existing countdowns before rendering new ones
        clearCountdownTimers();

        // Always clear the main results container before adding new content.
        resultsContainer.innerHTML = '';

        // Create a map to store the HTML elements for each line's data from the API response.
        const apiLineDataMap = new Map();
        if (apiData.linies) {
            apiData.linies.forEach(line => {
                line.estacions.forEach(stationPlatform => {
                    stationPlatform.linies_trajectes.forEach(route => {
                        const lineName = route.nom_linia; // e.g., "L1"
                        if (!apiLineDataMap.has(lineName)) {
                            apiLineDataMap.set(lineName, []);
                        }
                        
                        const lineInfoDiv = document.createElement('div');
                        lineInfoDiv.className = 'line-info';

                        const header = document.createElement('div');
                        header.className = 'line-header';
                        header.style.backgroundColor = `#${route.color_linia}`;
                        header.innerHTML = `
                            <span>Line ${route.nom_linia}</span>
                            <span>Destination: ${route.desti_trajecte}</span>
                        `;
                        lineInfoDiv.appendChild(header);

                        const trainList = document.createElement('div');
                        trainList.className = 'train-list';
                        // Associate the station code with the list for the fallback API
                        const stationCodeForThisRoute = stationPlatform.codi_estacio;
                        trainList.setAttribute('data-station-code', stationCodeForThisRoute);

                        // If linies_trajectes is empty, we have no route info from the primary API.
                        if (!stationPlatform.linies_trajectes || stationPlatform.linies_trajectes.length === 0) {
                            console.log(`[Primary API] ❌ No 'linies_trajectes' data for station code ${stationCodeForThisRoute}. Triggering fallback.`);
                            trainList.innerHTML = '<p>No real-time data. Checking schedule...</p>';
                            fetchFallbackSchedule(trainList, stationCodeForThisRoute);
                            lineInfoDiv.appendChild(trainList);
                            // Since we don't have a route, we can't create a unique header. We'll use what we have.
                            // This part of the logic might need refinement if we knew what to display in the header.
                            // For now, we add the train list to the first generated header.
                            if (!apiLineDataMap.has(lineName)) {
                                apiLineDataMap.set(lineName, []);
                            }
                            apiLineDataMap.get(lineName).push(lineInfoDiv);
                        } else {
                            stationPlatform.linies_trajectes.forEach(route => {
                                if (route.propers_trens && route.propers_trens.length > 0) {
                                    console.log(`[Primary API] ✅ Found real-time data for ${route.nom_linia} to ${route.desti_trajecte}.`);
                                    route.propers_trens.forEach(train => {
                                        const trainDiv = document.createElement('div');
                                        trainDiv.className = 'train';
                                        trainDiv.innerHTML = `
                                            <span class="train-destination">Next train (Live)</span>
                                            <span class="train-arrival" data-arrival-time="${train.temps_arribada}">Calculating...</span>
                                        `;
                                        trainList.appendChild(trainDiv);
                                    });
                                } else {
                                    console.log(`[Primary API] ❌ No 'propers_trens' data for ${route.nom_linia} to ${route.desti_trajecte}. Triggering fallback.`);
                                    trainList.innerHTML = '<p>No real-time data. Checking schedule...</p>';
                                    fetchFallbackSchedule(trainList, stationCodeForThisRoute);
                                }
                            });
                            lineInfoDiv.appendChild(trainList);
                            apiLineDataMap.get(lineName).push(lineInfoDiv);
                        }
                    });
                });
            });
        }


        // Now, iterate through all known lines for the station and display the data if available.
        // This regex correctly handles all known line formats like L1, L9S, L10N, and FM.
        // Add a check to ensure allStationLines is not null or undefined.
        if (!allStationLines) {
            if (apiLineDataMap.size === 0) {
                resultsContainer.innerHTML = '<p>No line information found for this station.</p>';
            }
            return;
        }

        // The `allStationLines` is now a clean array like ['L1', 'L4'], so we can iterate directly.
        allStationLines.forEach(lineName => {
            const lineDataElements = apiLineDataMap.get(lineName);

            if (lineDataElements) {
                lineDataElements.forEach(el => resultsContainer.appendChild(el));
            } else {
                // If no data from API for this line, show a placeholder box.
                resultsContainer.innerHTML += `
                    <div class="line-info">
                        <div class="line-header" style="background-color: #808080;">
                            <span>Line ${lineName}</span>
                        </div>
                        <div class="train-list">
                            <p>No real-time data available for this line.</p>
                        </div>
                    </div>
                `;
            }
        });

        // If after all checks, the container is still empty, it means no lines were found or matched.
        if (resultsContainer.innerHTML === '' && allStationLines) {
            resultsContainer.innerHTML = '<p>Could not retrieve data for the lines at this station.</p>';
        }

        // Find all the newly created arrival elements and start their countdowns.
        startCountdownTimers();
    }
    
    /**
     * Fetches scheduled times from the fallback API when real-time data is unavailable.
     * @param {HTMLElement} trainListElement - The container element to populate with results.
     * @param {string} stationCode - The station code for the API call.
     */
    async function fetchFallbackSchedule(trainListElement, stationCode) {
        const apiUrl = `${FALLBACK_API_URL}?app_id=${FALLBACK_APP_ID}&app_key=${FALLBACK_APP_KEY}&transit_namespace_element=metro&codi_element=${stationCode}&transit_namespace=metro`;
        console.log(`[FALLBACK API] Fetching from: ${apiUrl}`);

        let foundScheduledTimes = false;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) throw new Error('Fallback API request failed');
            const data = await response.json();

            trainListElement.innerHTML = ''; // Clear the "Checking..." message
            
            if (data.features && data.features.length > 0) {
                data.features.forEach(feature => {
                    const props = feature.properties;
                    const destination = props.DESTI_TRAJECTE;
                    const timeStrings = props.HORES_PAS.split(',');

                    const now = new Date();
                    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // Get date at midnight

                    // Find the next 2 upcoming times from the schedule
                    const upcomingTimes = timeStrings.map(timeStr => {
                        const [hours, minutes, seconds] = timeStr.split(':').map(Number);
                        const arrivalDate = new Date(today);
                        arrivalDate.setHours(hours, minutes, seconds, 0);
                        return arrivalDate;
                    }).filter(arrivalDate => arrivalDate > now) // Filter for future times
                      .slice(0, 2); // Get just the next two

                    if (upcomingTimes.length > 0) {
                        foundScheduledTimes = true;
                        upcomingTimes.forEach(arrivalTime => {
                            const trainDiv = document.createElement('div');
                            trainDiv.className = 'train';
                            trainDiv.innerHTML = `
                                <span class="train-destination">Scheduled (to ${destination})</span>
                                <span class="train-arrival" data-arrival-time="${arrivalTime.getTime()}">Calculating...</span>
                            `;
                            trainListElement.appendChild(trainDiv);
                        });
                    }
                });
            }

            if (!foundScheduledTimes) {
                trainListElement.innerHTML = '<p>No more scheduled departures found for today.</p>';
            }

            startCountdownTimers(); // Re-run to include any newly added timers
        } catch (error) {
            console.error('[FALLBACK API] Error:', error);
            trainListElement.innerHTML = '<p>Could not retrieve scheduled times.</p>';
        }
    }

    /**
     * Finds all arrival time elements and starts a countdown timer for each.
     */
    function startCountdownTimers() {
        const arrivalElements = document.querySelectorAll('.train-arrival');
        arrivalElements.forEach(element => {
            const arrivalTimestamp = parseInt(element.getAttribute('data-arrival-time'), 10);

            const updateCountdown = () => {
                const now = new Date().getTime();
                const arrivalDate = new Date(arrivalTimestamp);
                const diffMs = arrivalDate.getTime() - now;

                const arrivalHours = arrivalDate.getHours().toString().padStart(2, '0');
                const arrivalMinutes = arrivalDate.getMinutes().toString().padStart(2, '0');
                const absoluteTime = `${arrivalHours}:${arrivalMinutes}`;

                if (diffMs <= 0) {
                    element.textContent = `Arriving now (${absoluteTime})`;
                } else {
                    const minutes = Math.floor(diffMs / 60000);
                    const seconds = Math.floor((diffMs % 60000) / 1000);
                    element.innerHTML = `${absoluteTime} <span style="font-weight:normal; color:#666;">(in ${minutes}m ${seconds.toString().padStart(2, '0')}s)</span>`;
                }
            };

            updateCountdown(); // Update immediately
            const intervalId = setInterval(updateCountdown, 1000); // Then update every second
            countdownIntervalIds.push(intervalId);
        });
    }

    /**
     * Clears all active countdown intervals.
     */
    function clearCountdownTimers() {
        countdownIntervalIds.forEach(id => clearInterval(id));
        countdownIntervalIds = [];
    }

    /**
     * Shows an error message in the UI.
     * @param {string} message - The error message to display.
     */
    function showError(message) {
        // Stop any running timers
        if (autoRefreshIntervalId) clearInterval(autoRefreshIntervalId);
        clearCountdownTimers();
        timestampContainer.textContent = ''; // Also clear the timestamp on error

        resultsContainer.innerHTML = '';
        errorMessageDiv.textContent = message;
    }

    /**
     * Updates the timestamp display with the current time.
     */
    function updateTimestamp() {
        const now = new Date();
        const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
        const formattedTime = now.toLocaleDateString('en-US', options).replace(',', '');
        timestampContainer.textContent = `Last updated: ${formattedTime}`;
    }

    // --- Initialization ---
    loadStations();
    // Add event listener to the Choices.js instance, not the original select element.
    stationSelect.addEventListener('choice', fetchStationData);
});
