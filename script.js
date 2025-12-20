document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const PRIMARY_APP_ID = '00ebfbd8';
    const PRIMARY_APP_KEY = '106da0e97d453028e6751b44e675f208';
    const API_BASE_URL = 'https://api.tmb.cat/v1/itransit/metro/estacions';
    const FALLBACK_APP_ID = '4c132798';
    const FALLBACK_APP_KEY = '8504ae3a636b155724a1c7e140ee039f';
    const FALLBACK_API_URL = 'https://api.tmb.cat/v1/transit/core/horaris/';
    const STATIONS_CSV_PATH = 'estacions_linia.csv';
    const AUTO_REFRESH_INTERVAL = 120000; // 2 minutes (increased from 30 seconds)
    const DEBUG_MODE = false; // Set to true for development debugging

    // --- DOM Elements ---
    const stationSelect = document.getElementById('station-select');
    const resultsContainer = document.getElementById('results-container');
    const errorMessageDiv = document.getElementById('error-message');
    const timestampContainer = document.getElementById('timestamp-container');
    const favoritesSection = document.getElementById('favorites-section');
    const favoritesContainer = document.getElementById('favorites-container');
    const languageSelect = document.getElementById('language-select');

    // --- State Management ---
    let autoRefreshIntervalId = null;
    let countdownIntervalIds = [];
    let choicesInstance = null;
    let abortController = null;
    let fallbackDataCache = new Map(); // Cache fallback API responses by station code
    let stationsList = []; // Store stations list for URL loading
    let lineColorMap = new Map(); // Map of line names to their colors (e.g., 'L1' -> 'CE1126')
    let selectedLineFilter = null; // Currently selected line filter (null = show all)
    let currentLanguage = 'en'; // Current language (default: English)

    // --- Utility Functions ---
    /**
     * Sorts line names numerically (L1, L2, L3, L9, L10, L10S, etc.)
     * @param {string} a - First line name (e.g., "L1", "L10S")
     * @param {string} b - Second line name (e.g., "L2", "L9")
     * @returns {number} Comparison result for sorting
     */
    function sortLinesNumerically(a, b) {
        // Extract number from line name (e.g., "L1" -> 1, "L10S" -> 10)
        const getLineNumber = (lineName) => {
            const match = lineName.match(/L(\d+)/);
            return match ? parseInt(match[1], 10) : 9999; // Put non-matching lines at the end
        };
        
        // Extract suffix (e.g., "L10S" -> "S", "L1" -> "")
        const getLineSuffix = (lineName) => {
            const match = lineName.match(/L\d+(.*)/);
            return match ? match[1] : '';
        };
        
        const numA = getLineNumber(a);
        const numB = getLineNumber(b);
        
        // First sort by number
        if (numA !== numB) {
            return numA - numB;
        }
        
        // If numbers are equal, sort by suffix (empty suffix comes first)
        const suffixA = getLineSuffix(a);
        const suffixB = getLineSuffix(b);
        return suffixA.localeCompare(suffixB);
    }
    
    /**
     * Conditional logging for debug mode
     */
    const debugLog = (...args) => {
        if (DEBUG_MODE) console.log(...args);
    };

    /**
     * Get translation for a key
     * @param {string} key - Translation key
     * @returns {string} Translated text
     */
    function t(key) {
        return translations[currentLanguage]?.[key] || translations['en'][key] || key;
    }

    /**
     * Update URL with language parameter
     * @param {string} lang - Language code (en, es, ca, zh)
     */
    function updateLanguageInURL(lang) {
        const url = new URL(window.location.href);
        url.searchParams.set('lang', lang);
        window.history.replaceState({}, '', url);
    }

    /**
     * Get language from URL
     * @returns {string} Language code
     */
    function getLanguageFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        const lang = urlParams.get('lang');
        if (lang && ['en', 'es', 'ca', 'zh'].includes(lang)) {
            return lang;
        }
        return 'en'; // Default to English
    }

    /**
     * Change language and update all text
     * @param {string} lang - Language code
     */
    function changeLanguage(lang) {
        if (!['en', 'es', 'ca', 'zh'].includes(lang)) return;
        
        currentLanguage = lang;
        document.documentElement.lang = lang;
        
        // Update language selector
        if (languageSelect) {
            languageSelect.value = lang;
        }
        
        // Update URL
        updateLanguageInURL(lang);
        
        // Update all translatable elements
        updateTranslations();
    }

    /**
     * Update all text elements with translations
     */
    function updateTranslations() {
        // Update elements with data-translate attribute
        document.querySelectorAll('[data-translate]').forEach(el => {
            const key = el.getAttribute('data-translate');
            el.textContent = t(key);
        });
        
        // Update title attributes
        document.querySelectorAll('[data-translate-title]').forEach(el => {
            const key = el.getAttribute('data-translate-title');
            el.title = t(key);
        });
        
        // Update aria-label attributes
        document.querySelectorAll('[data-translate-aria]').forEach(el => {
            const key = el.getAttribute('data-translate-aria');
            el.setAttribute('aria-label', t(key));
        });
        
        // Update placeholder text
        const loadingOption = stationSelect?.querySelector('option[value=""]');
        if (loadingOption) {
            loadingOption.textContent = t('loadingStations');
        }
        
        // Update Choices.js placeholder if instance exists
        if (choicesInstance) {
            // Update the placeholder by accessing the input element
            const input = choicesInstance.input?.element;
            if (input) {
                input.placeholder = t('chooseStation');
            }
        }
        
        // Update page title
        const currentStationName = choicesInstance?.getValue()?.value || choicesInstance?.getValue()?.label;
        if (currentStationName) {
            document.title = `${currentStationName} - ${t('title')}`;
        } else {
            document.title = t('title');
        }
        
        // Update dynamically created content in results container
        updateDynamicContentTranslations();
        
        // Update timestamp area (buttons, labels)
        updateTimestampTranslations();
        
        // Update favorites section
        updateFavoritesTranslations();
    }
    
    /**
     * Update translations for dynamically created content in results container
     */
    function updateDynamicContentTranslations() {
        // Update "Next train" labels
        resultsContainer.querySelectorAll('.train-destination').forEach(el => {
            const text = el.textContent.trim();
            if (text === 'Next train' || text === 'Próximo tren' || text === 'Pròxim tren' || text === '下一班') {
                el.textContent = t('nextTrain');
            } else if (text === 'Scheduled' || text === 'Programado' || text === 'Programat' || text === '已安排') {
                el.textContent = t('scheduled');
            }
        });
        
        // Update "Destination:" labels in line headers
        resultsContainer.querySelectorAll('.line-header').forEach(header => {
            const spans = header.querySelectorAll('span');
            if (spans.length >= 2) {
                const secondSpan = spans[1];
                const text = secondSpan.textContent;
                // Check if it contains "Destination:" pattern
                if (text.includes('Destination:') || text.includes('Destino:') || text.includes('Destí:') || text.includes('目的地：')) {
                    const destination = text.split(/[:：]/).pop().trim();
                    secondSpan.textContent = `${t('destination')} ${destination}`;
                }
            }
        });
        
        // Update "Calculating..." text
        resultsContainer.querySelectorAll('.train-arrival').forEach(el => {
            if (el.textContent.trim() === 'Calculating...' || 
                el.textContent.trim() === 'Calculando...' || 
                el.textContent.trim() === 'Calculant...' ||
                el.textContent.trim() === '计算中...') {
                // Only update if it's still calculating (not a time)
                if (!el.getAttribute('data-arrival-time') || el.classList.contains('calculating')) {
                    el.textContent = t('calculating');
                }
            }
        });
        
        // Update "Arriving now" text
        resultsContainer.querySelectorAll('.train-arrival.arriving-now').forEach(el => {
            const text = el.textContent;
            if (text.includes('Arriving now') || text.includes('Llegando ahora') || 
                text.includes('Arribant ara') || text.includes('即将到达')) {
                const match = text.match(/\(([^)]+)\)/);
                const timePart = match ? match[1] : '';
                el.textContent = timePart ? `${t('arrivingNow')} (${timePart})` : t('arrivingNow');
            }
        });
        
        // Update "in" text in countdown
        resultsContainer.querySelectorAll('.countdown').forEach(el => {
            const text = el.textContent;
            if (text.includes('in ') || text.includes('en ') || text.includes('dins de ') || text.includes('在 ')) {
                const match = text.match(/\(([^)]+)\)/);
                if (match) {
                    const timePart = match[1].replace(/^(in |en |dins de |在 )/, '');
                    el.textContent = `(${t('in')} ${timePart})`;
                }
            }
        });
        
        // Update error messages
        const errorDiv = document.getElementById('error-message');
        if (errorDiv && errorDiv.textContent) {
            const errorText = errorDiv.textContent.trim();
            // Map common error messages to translation keys
            const errorMap = {
                'Please select a station.': 'pleaseSelectStation',
                'Por favor, selecciona una estación.': 'pleaseSelectStation',
                'Si us plau, seleccioneu una estació.': 'pleaseSelectStation',
                '请选择一个车站。': 'pleaseSelectStation',
                'Could not get information. Please try again later.': 'couldNotGetInfo',
                'No se pudo obtener información. Por favor, inténtalo de nuevo más tarde.': 'couldNotGetInfo',
                'No s\'ha pogut obtenir informació. Si us plau, torna-ho a intentar més tard.': 'couldNotGetInfo',
                '无法获取信息。请稍后再试。': 'couldNotGetInfo'
            };
            if (errorMap[errorText]) {
                errorDiv.textContent = t(errorMap[errorText]);
            }
        }
    }
    
    /**
     * Update translations for timestamp area (buttons, labels)
     */
    function updateTimestampTranslations() {
        // Update refresh button
        const refreshBtn = document.getElementById('refresh-btn');
        if (refreshBtn) {
            refreshBtn.title = t('refresh');
            refreshBtn.setAttribute('aria-label', t('refreshAria'));
        }
        
        // Update favorite button
        const favoriteBtn = document.getElementById('favorite-btn');
        if (favoriteBtn) {
            const isFav = favoriteBtn.classList.contains('active');
            favoriteBtn.title = isFav ? t('removeFromFavorites') : t('addToFavorites');
            favoriteBtn.setAttribute('aria-label', isFav ? t('removeFromFavorites') : t('addToFavorites'));
        }
        
        // Update "Last updated:" label - find the timestamp text span
        const timestampContent = timestampContainer.querySelector('.timestamp-content');
        if (timestampContent) {
            const timestampSpan = timestampContent.querySelector('span:first-child');
            if (timestampSpan) {
                const timeText = timestampSpan.textContent;
                // Extract time part (format: "Last updated: 10:30 AM" or "10:30")
                const timeMatch = timeText.match(/(\d{1,2}:\d{2}(?:\s+[AP]M)?)/);
                if (timeMatch) {
                    timestampSpan.textContent = `${t('lastUpdated')} ${timeMatch[1]}`;
                }
            }
        }
    }
    
    /**
     * Update translations for favorites section
     */
    function updateFavoritesTranslations() {
        // Update favorites header
        const favoritesHeader = document.querySelector('.favorites-header span');
        if (favoritesHeader) {
            favoritesHeader.textContent = t('favoriteStations');
        }
        
        // Update favorite remove buttons
        favoritesContainer.querySelectorAll('.favorite-remove').forEach(btn => {
            btn.title = t('removeFromFavorites');
            btn.setAttribute('aria-label', t('removeFromFavorites'));
        });
    }

    /**
     * Converts a station name to a URL-friendly slug
     * @param {string} stationName - The station name to convert
     * @returns {string} URL-friendly slug
     */
    function stationNameToSlug(stationName) {
        return stationName
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // Remove accents
            .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    }

    /**
     * Converts a URL slug back to a station name (finds closest match)
     * @param {string} slug - The URL slug
     * @param {Array} stations - Array of station objects with name property
     * @returns {string|null} Station name or null if not found
     */
    function slugToStationName(slug, stations) {
        const normalizedSlug = slug.toLowerCase();
        // Try exact match first
        const exactMatch = stations.find(s => 
            stationNameToSlug(s.name) === normalizedSlug
        );
        if (exactMatch) return exactMatch.name;
        
        // Try partial match
        const partialMatch = stations.find(s => 
            stationNameToSlug(s.name).includes(normalizedSlug) ||
            normalizedSlug.includes(stationNameToSlug(s.name))
        );
        return partialMatch ? partialMatch.name : null;
    }

    /**
     * Updates the URL with the current station name
     * Uses hash-based routing for GitHub Pages compatibility
     * @param {string} stationName - The station name to set in URL
     */
    function updateURL(stationName) {
        // Always preserve favorites when updating URL
        const currentFavorites = getFavoritesFromURL();
        const favoritesStr = currentFavorites.length > 0 ? `&favorites=${currentFavorites.join(',')}` : '';
        
        if (!stationName) {
            // Keep favorites in URL even if no station selected
            const newURL = window.location.pathname + window.location.search + 
                (favoritesStr ? `#${favoritesStr.replace('&', '')}` : '');
            
            if (window.history.replaceState) {
                window.history.replaceState(null, '', newURL);
            }
            // Reset page title
            document.title = 'TMB Metro Master';
            return;
        }
        
        const slug = stationNameToSlug(stationName);
        // Use hash-based routing: #station-slug&favorites=slug1,slug2
        // Always preserve favorites when changing stations
        const newURL = window.location.pathname + window.location.search + '#' + slug + favoritesStr;
        
        // Update URL without page reload
        if (window.history.replaceState) {
            window.history.replaceState({ station: stationName }, '', newURL);
            // Update page title
            document.title = `${stationName} - TMB Metro Master`;
        }
    }

    /**
     * Reads the station from URL and selects it
     * Supports both hash-based (#station) and path-based (/station) routing
     */
    let loadStationRetryCount = 0;
    const MAX_RETRIES = 20; // Maximum number of retries (20 * 200ms = 4 seconds max)
    
    function loadStationFromURL() {
        // Prevent infinite loops
        if (loadStationRetryCount >= MAX_RETRIES) {
            debugLog(`[URL] Max retries (${MAX_RETRIES}) reached. Stations may not be loaded.`);
            loadStationRetryCount = 0; // Reset for next attempt
            return;
        }
        
        let slug = null;
        
        // First, try hash-based routing (works with GitHub Pages)
        // Format: #station-slug or #station-slug&favorites=slug1,slug2
        const hash = window.location.hash.replace('#', '');
        if (hash) {
            // Extract station slug (before &favorites=)
            slug = hash.split('&')[0];
            // Load favorites from URL
            loadFavoritesFromURL();
        } else {
            // Fallback to path-based routing (for when 404.html works)
            let path = window.location.pathname;
            
            // Handle GitHub Pages 404 redirect (path might be /index.html/station-name)
            if (path.includes('/index.html/')) {
                path = path.replace('/index.html', '');
            }
            
            // Extract the last segment of the path (the station slug)
            const pathParts = path.split('/').filter(p => p && p !== 'index.html' && p !== '');
            slug = pathParts[pathParts.length - 1];
        }
        
        if (!slug || slug === 'index.html' || slug === '') {
            loadStationRetryCount = 0; // Reset counter
            return; // No station in URL
        }
        
        // Wait for stations to be loaded - use stored stationsList instead of Choices.js internal
        if (!choicesInstance || stationsList.length === 0) {
            loadStationRetryCount++;
            if (loadStationRetryCount % 5 === 0) { // Log every 5th retry to reduce spam
                debugLog(`[URL] Waiting for stations... (${loadStationRetryCount}/${MAX_RETRIES})`);
            }
            setTimeout(loadStationFromURL, 200);
            return;
        }
        
        debugLog(`[URL] Found ${stationsList.length} stations, searching for slug: "${slug}"`);
        loadStationRetryCount = 0; // Reset counter on success
        
        // Find station by slug using stored stations list
        const stationName = slugToStationName(slug, stationsList.map(s => ({ name: s.name })));
        
        if (stationName) {
            debugLog(`✓ Found station: "${stationName}" for slug: "${slug}"`);
            
            // Find the choice item from stored list
            const choiceItem = stationsList.find(s => s.name === stationName);
            
            if (choiceItem) {
                // Set the value in Choices.js for UI consistency
                // Use multiple methods to ensure it works on all devices, especially mobile
                const stationValue = choiceItem.value || choiceItem.name;
                debugLog(`[URL] Setting station value: "${stationValue}"`);
                
                // Function to set the value - will be called multiple times
                const setStationValue = () => {
                    try {
                        // Check if Choices.js is ready
                        if (!choicesInstance) {
                            debugLog('[URL] Choices.js instance not ready yet');
                            return false;
                        }
                        
                        // Try to set the value directly - Choices.js should handle it
                        // We don't need to access choices array, just use setValue
                        try {
                            choicesInstance.setValue([stationValue]);
                            debugLog(`[URL] Set value using setValue: ${stationValue}`);
                            
                            // Also set the underlying select element directly
                            if (stationSelect) {
                                stationSelect.value = stationValue;
                            }
                            
                            // Manually update the display element after a short delay
                            setTimeout(() => {
                                const singleItem = document.querySelector('.choices__item--selectable') || 
                                                 document.querySelector('.choices__single .choices__item');
                                if (singleItem) {
                                    singleItem.textContent = stationValue;
                                    debugLog(`[URL] Updated display element with: "${stationValue}"`);
                                } else {
                                    // If element not found, try to find it again
                                    setTimeout(() => {
                                        const singleItem2 = document.querySelector('.choices__item--selectable') || 
                                                           document.querySelector('.choices__single .choices__item');
                                        if (singleItem2) {
                                            singleItem2.textContent = stationValue;
                                            debugLog(`[URL] Updated display element (retry) with: "${stationValue}"`);
                                        }
                                    }, 200);
                                }
                            }, 100);
                            
                            return true; // Success
                        } catch (setError) {
                            debugLog('[URL] setValue failed:', setError);
                            return false;
                        }
                    } catch (e) {
                        debugLog('[URL] Could not set Choices.js value:', e);
                        return false; // Failed
                    }
                };
                
                // Set immediately
                setStationValue();
                
                // Retry multiple times to ensure it works (especially on mobile)
                setTimeout(() => setStationValue(), 100);
                setTimeout(() => setStationValue(), 300);
                setTimeout(() => setStationValue(), 600);
                setTimeout(() => setStationValue(), 1000);
                
                // Wait for Choices.js to update, then fetch data directly with the station data
                setTimeout(() => {
                    // Create the station data object to pass directly
                    const stationData = {
                        value: choiceItem.value || choiceItem.name,
                        label: choiceItem.label || choiceItem.name,
                        customProperties: choiceItem.customProperties || {
                            apiCodes: choiceItem.apiCodes || [],
                            lines: choiceItem.lines || []
                        }
                    };
                    
                    debugLog(`[URL] Loading station data for: ${stationName}`);
                    debugLog(`[URL] Station has ${stationData.customProperties.apiCodes.length} API code(s)`);
                    
                    // Call fetchStationData directly with the station data
                    // This bypasses Choices.js getValue() issues
                    fetchStationData(stationData);
                    
                    // After fetching, ensure the display is still correct
                    setTimeout(() => {
                        try {
                            const stationValue = choiceItem.value || choiceItem.name;
                            if (choicesInstance) {
                                choicesInstance.setValue([stationValue]);
                                
                                // Also update display element
                                setTimeout(() => {
                                    const singleItem = document.querySelector('.choices__item--selectable') || 
                                                     document.querySelector('.choices__single .choices__item');
                                    if (singleItem) {
                                        singleItem.textContent = stationValue;
                                        debugLog(`[URL] Post-fetch: Updated display element with: "${stationValue}"`);
                                    }
                                }, 100);
                            }
                        } catch (e) {
                            debugLog('Could not refresh Choices.js display:', e);
                        }
                    }, 200);
                }, 300);
            } else {
                debugLog(`Could not find choice item for station: ${stationName}`);
            }
        } else {
            debugLog(`Station not found for slug: ${slug}`);
            // Clear invalid URL
            updateURL(null);
        }
    }

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
        debugLog("Attempting to load stations from CSV...");
        try {
            const response = await fetch(STATIONS_CSV_PATH);
            if (!response.ok) {
                throw new Error(`Could not load the stations file: ${response.statusText}`);
            }
            const csvText = await response.text();

            // Use a map to group lines by station name, ensuring each station appears only once
            const stationsMap = new Map();
            const lines = csvText.split('\n');
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const columns = parseCsvLine(line);
                const stationName = safeTrim(columns[7]); // NOM_ESTACIO
                const lineSpecificCode = safeTrim(columns[6]); // CODI_ESTACIO
                const lineName = safeTrim(columns[11]); // NOM_LINIA
                const lineColor = safeTrim(columns[23]); // COLOR_LINIA

                if (!stationName || !lineSpecificCode || !lineName) continue;

                // Store line color in lineColorMap immediately from CSV
                if (lineColor && lineColor.length > 0) {
                    lineColorMap.set(lineName, lineColor);
                }

                if (stationsMap.has(stationName)) {
                    const stationData = stationsMap.get(stationName);
                    stationData.lines.add(lineName);
                    stationData.apiCodes.add(lineSpecificCode);
                } else {
                    stationsMap.set(stationName, {
                        name: stationName,
                        apiCodes: new Set([lineSpecificCode]),
                        lines: new Set([lineName])
                    });
                }
            }

            debugLog("--- Station Grouping Report ---");
            stationsMap.forEach((stationData, stationName) => {
                debugLog(`Station: "${stationName}" | API Codes: [${Array.from(stationData.apiCodes).join(', ')}] | Lines: [${Array.from(stationData.lines).join(', ')}]`);
            });
            debugLog("---------------------------------");

            const stations = Array.from(stationsMap.values())
                .map(station => ({ 
                    ...station, 
                    apiCodes: Array.from(station.apiCodes), 
                    lines: Array.from(station.lines).sort() 
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            // Remove any duplicate stations by value (extra safety check)
            const uniqueStations = [];
            const seenValues = new Set();
            for (const station of stations) {
                if (!seenValues.has(station.name)) {
                    seenValues.add(station.name);
                    uniqueStations.push(station);
                }
            }

            const choices = uniqueStations.map(station => {
                // Create line indicators HTML
                const lines = (station.lines || []).sort(sortLinesNumerically);
                const lineIndicators = lines.map(lineName => {
                    const color = lineColorMap.get(lineName) || '808080';
                    return `<span class="dropdown-line-indicator" style="background-color: #${color}">${lineName}</span>`;
                }).join('');
                
                // Include line indicators on the right side of the station name
                const labelHTML = lineIndicators 
                    ? `<span class="choices-station-name">${station.name}</span><span class="choices-line-indicators">${lineIndicators}</span>`
                    : station.name;
                
                return {
                    value: station.name,
                    label: labelHTML,
                    customProperties: { apiCodes: station.apiCodes, lines: station.lines }
                };
            });

            // Store stations list for URL loading (with full data structure)
            stationsList = uniqueStations.map(s => ({
                name: s.name,
                value: s.name,
                label: s.name,
                apiCodes: s.apiCodes, // Store directly for easier access
                lines: s.lines, // Store directly for easier access
                customProperties: { apiCodes: s.apiCodes, lines: s.lines }
            }));

            // Destroy existing Choices.js instance if it exists to prevent duplicates
            if (choicesInstance) {
                try {
                    choicesInstance.destroy();
                } catch (e) {
                    debugLog('Error destroying Choices instance:', e);
                }
                choicesInstance = null;
            }
            
            // Clear the select element
            stationSelect.innerHTML = '<option value="">' + t('loadingStations') + '</option>';
            
            choicesInstance = new Choices(stationSelect, {
                choices: choices,
                searchEnabled: true,
                itemSelectText: '',
                shouldSort: false,
                placeholder: true,
                placeholderValue: t('chooseStation'),
                allowHTML: true, // Allow HTML in labels
                searchChoices: true, // Enable search
                position: 'bottom', // Always position dropdown below
                maxItemCount: 8, // Limit visible items, rest scrollable
                renderSelectedChoices: 'always', // Always show selected
                duplicateItemsAllowed: false // Prevent duplicate items
            });
            debugLog(`✓ Stations loaded: ${stationsList.length} stations available`);
            
            // Load favorites from URL
            loadFavoritesFromURL();
            
            // Try to load station from URL after stations are loaded
            // Use a longer delay to ensure Choices.js is fully ready, especially on mobile
            setTimeout(() => {
                loadStationFromURL();
            }, 300);
        } catch (error) {
            debugLog("ERROR in loadStations:", error);
            showError(t('couldNotLoadStations'));
        }
    }

    /**
     * Fetches and displays data for a station from the API.
     * @param {Object} overrideStationData - Optional station data to use instead of reading from Choices.js
     */
    async function fetchStationData(overrideStationData = null) {
        if (!choicesInstance) {
            debugLog("Cannot fetch data: Choices.js instance is not available.");
            return;
        }

        let selectedItem = overrideStationData;
        
        // If no override provided, try to get from Choices.js
        if (!selectedItem) {
            const getValueResult = choicesInstance.getValue();
            
            // Handle different return types from Choices.js
            if (getValueResult && typeof getValueResult === 'object' && !Array.isArray(getValueResult)) {
                // If it's an object (but might be a CustomEvent), check if it has the data we need
                if (getValueResult.detail && getValueResult.detail.customProperties) {
                    // It's a CustomEvent from the 'choice' event
                    selectedItem = {
                        value: getValueResult.detail.value || getValueResult.detail.id,
                        label: getValueResult.detail.label,
                        customProperties: getValueResult.detail.customProperties || {}
                    };
                    debugLog(`[API] Extracted data from CustomEvent for: ${selectedItem.value}`);
                } else if (getValueResult.customProperties) {
                    // It's already the station data object
                    selectedItem = getValueResult;
                } else {
                    // Try to get value as string and look it up
                    const stationName = getValueResult.value || getValueResult.label || getValueResult;
                    const fullStationData = stationsList.find(s => s.name === stationName);
                    if (fullStationData) {
                        selectedItem = {
                            value: fullStationData.value || fullStationData.name,
                            label: fullStationData.label || fullStationData.name,
                            customProperties: fullStationData.customProperties || {}
                        };
                        debugLog(`[API] Resolved station data for: ${stationName}`);
                    }
                }
            } else if (typeof getValueResult === 'string' || (Array.isArray(getValueResult) && typeof getValueResult[0] === 'string')) {
                // If getValue() returns just a string, look up the full station data
                const stationName = Array.isArray(getValueResult) ? getValueResult[0] : getValueResult;
                const fullStationData = stationsList.find(s => s.name === stationName);
                if (fullStationData) {
                    selectedItem = {
                        value: fullStationData.value || fullStationData.name,
                        label: fullStationData.label || fullStationData.name,
                        customProperties: fullStationData.customProperties || {}
                    };
                    debugLog(`[API] Resolved station data for: ${stationName}`);
                } else {
                    debugLog(`[API] Could not find station data for: ${stationName}`);
                }
            }
        }
        
        const stationApiCodes = selectedItem?.customProperties?.apiCodes;
        if (!stationApiCodes || stationApiCodes.length === 0) {
            debugLog('[API] No API codes found for selected station:', selectedItem);
            debugLog('[API] Selected item structure:', {
                hasValue: !!selectedItem?.value,
                hasLabel: !!selectedItem?.label,
                hasCustomProperties: !!selectedItem?.customProperties,
                customPropertiesKeys: selectedItem?.customProperties ? Object.keys(selectedItem.customProperties) : [],
                fullItem: selectedItem
            });
            showError(t('pleaseSelectStation'));
            updateURL(null); // Clear URL if no valid selection
            return;
        }
        
        // Update URL with selected station name (only if hash is different to preserve during auto-refresh)
        const stationName = selectedItem.value || selectedItem.label;
        const currentHash = window.location.hash.replace('#', '');
        const expectedSlug = stationNameToSlug(stationName);
        if (currentHash !== expectedSlug) {
            updateURL(stationName);
        }

        // Stop any previous auto-refresh and countdown timers
        if (autoRefreshIntervalId) {
            clearInterval(autoRefreshIntervalId);
            autoRefreshIntervalId = null;
        }
        clearCountdownTimers();
        
        // Abort any ongoing fetch request before starting a new one
        if (abortController) abortController.abort();
        abortController = new AbortController();

        // Clear previous results and show loading state
        showError(''); // Hide error div
        resultsContainer.innerHTML = `<p class="loading">${t('loadingTrainData')}</p>`;

        try {
            debugLog(`[API] Fetching data for "${selectedItem.value}" (${stationApiCodes.length} code(s))`);

            // Create an array of fetch promises, one for each group code
            const fetchPromises = stationApiCodes.map((code, index) => {
                const apiUrl = `${API_BASE_URL}?estacions=${code}&app_id=${PRIMARY_APP_ID}&app_key=${PRIMARY_APP_KEY}`;
                
                return fetch(apiUrl, { signal: abortController.signal })
                    .then(async res => {
                        if (!res.ok) {
                            throw new Error(`API Error for station ID ${code}: ${res.statusText}`);
                        }
                    return res.json();
                    })
                    .catch(error => {
                        // Return null for failed requests so we can handle partial failures
                        if (error.name === 'AbortError') throw error;
                        debugLog(`[API] Request failed for station code ${code}:`, error.message);
                        return null;
                });
            });

            // Use allSettled to handle partial failures gracefully
            const results = await Promise.allSettled(fetchPromises);
            const successfulResponses = results
                .filter(result => result.status === 'fulfilled' && result.value !== null)
                .map(result => result.value);

            // Merge the 'linies' arrays from all successful responses
            const mergedData = successfulResponses.reduce((acc, current) => {
                if (current?.linies) {
                    acc.linies = (acc.linies || []).concat(current.linies);
                }
                return acc;
            }, {});

            // Check if we have any data or if fallback will be used
            // Don't throw error yet - let displayResults try fallback first
            const hasPrimaryData = mergedData.linies && mergedData.linies.length > 0;
            
            if (!hasPrimaryData && successfulResponses.length === 0) {
                // All requests failed, but we'll try fallback in displayResults
                debugLog('[API] All primary requests failed, will try fallback API');
            }

            resultsContainer.innerHTML = '';
            // Clear line filter when fetching new station data
            selectedLineFilter = null;
            const displaySuccess = await displayResults(mergedData, selectedItem.customProperties.lines, stationApiCodes);
            
            // Only show error if both primary and fallback failed
            if (!displaySuccess && successfulResponses.length === 0) {
                throw new Error('All API requests failed and no fallback data available');
            }
            
            // Store current station name globally for use in updateTimestamp
            const stationName = selectedItem.value || selectedItem.label;
            
            updateTimestamp(selectedItem.customProperties.lines, mergedData, stationName);
            
            // Update favorites display with current station info
            updateFavoritesDisplay();

            // Start auto-refreshing - always get current station from URL or Choices.js
            // This ensures auto-refresh always uses the currently selected station
            autoRefreshIntervalId = setInterval(() => {
                // Get current station from URL hash first (most reliable)
                const hash = window.location.hash.replace('#', '');
                if (hash) {
                    const slug = hash.split('&')[0]; // Extract station slug (before &favorites=)
                    if (slug) {
                        const stationName = slugToStationName(slug, stationsList.map(s => ({ name: s.name })));
                        if (stationName) {
                            const stationData = stationsList.find(s => s.name === stationName);
                            if (stationData) {
                                const refreshStationData = {
                                    value: stationData.value || stationData.name,
                                    label: stationData.label || stationData.name,
                                    customProperties: stationData.customProperties || {
                                        apiCodes: stationData.apiCodes || [],
                                        lines: stationData.lines || []
                                    }
                                };
                                fetchStationData(refreshStationData);
                                return;
                            }
                        }
                    }
                }
                
                // Fallback: get from Choices.js if URL doesn't have station
                if (choicesInstance) {
                    const getValueResult = choicesInstance.getValue();
                    if (getValueResult) {
                        let stationName = null;
                        if (typeof getValueResult === 'string') {
                            stationName = getValueResult;
                        } else if (getValueResult.value) {
                            stationName = getValueResult.value;
                        } else if (getValueResult.label) {
                            stationName = getValueResult.label;
                        }
                        
                        if (stationName) {
                            const stationData = stationsList.find(s => s.name === stationName);
                            if (stationData) {
                                const refreshStationData = {
                                    value: stationData.value || stationData.name,
                                    label: stationData.label || stationData.name,
                                    customProperties: stationData.customProperties || {
                                        apiCodes: stationData.apiCodes || [],
                                        lines: stationData.lines || []
                                    }
                                };
                                fetchStationData(refreshStationData);
                                return;
                            }
                        }
                    }
                }
                
                // If no station found, don't refresh (user might have cleared selection)
                debugLog('[Auto-refresh] No station selected, skipping refresh');
            }, AUTO_REFRESH_INTERVAL);
        } catch (error) {
            if (error.name === 'AbortError') {
                debugLog('Fetch aborted by new request.');
                return;
            }
            debugLog("ERROR in fetchStationData:", error);
            showError(t('couldNotGetInfo'));
        }
    }

    /**
     * Displays the results from the API on the page.
     * @param {object} apiData - The response object from the API.
     * @param {string[]} allStationLines - An array of all lines for the station, e.g., ['L1', 'L4'].
     * @param {string[]} stationApiCodes - An array of API codes used for the station.
     */
    async function displayResults(apiData, allStationLines, stationApiCodes) {
        debugLog(`\n🎨 [DISPLAY] Processing results for display:`);
        debugLog(`   Station Lines:`, allStationLines);
        debugLog(`   API Codes:`, stationApiCodes);
        debugLog(`   API Data:`, apiData);
        
        // Clear any existing countdowns before rendering new ones
        clearCountdownTimers();
        fallbackDataCache.clear(); // Clear fallback cache for new request

        // Always clear the main results container before adding new content.
        resultsContainer.innerHTML = '';

        // Create a map to store the HTML elements for each line's data from the API response.
        // Structure: Map<lineName, Map<destination, {element, stationCode, color}>>
        const apiLineDataMap = new Map();
        const stationsNeedingFallback = new Set(); // Track which station codes need fallback
        
        if (apiData.linies) {
            debugLog(`\n📊 [DISPLAY] Processing ${apiData.linies.length} line(s) from API data`);
            apiData.linies.forEach((line, lineIndex) => {
                debugLog(`\n   Line ${lineIndex + 1}:`, {
                    nom: line.nom_linia || line.nom,
                    estacionsCount: line.estacions?.length || 0
                });
                
                line.estacions.forEach((stationPlatform, stationIndex) => {
                    debugLog(`     Station Platform ${stationIndex + 1}:`, {
                        codi_estacio: stationPlatform.codi_estacio,
                        linies_trajectesCount: stationPlatform.linies_trajectes?.length || 0
                    });
                    
                    const stationCode = stationPlatform.codi_estacio;
                    const lineName = line.nom_linia || line.nom;
                    const lineColor = line.color_linia || '808080';
                    
                    // Update line color map
                    if (lineName && line.color_linia) {
                        lineColorMap.set(lineName, line.color_linia);
                    }
                    
                    // Check if we need fallback for this station
                    const needsFallback = !stationPlatform.linies_trajectes || 
                                         stationPlatform.linies_trajectes.length === 0 ||
                                         stationPlatform.linies_trajectes.every(route => 
                                             !route.propers_trens || route.propers_trens.length === 0
                                         );
                    
                    if (needsFallback) {
                        debugLog(`       ⚠️  Station code ${stationCode} needs fallback data`);
                        stationsNeedingFallback.add(stationCode);
                    } else {
                        // Process real-time data
                        stationPlatform.linies_trajectes.forEach((route, routeIndex) => {
                            debugLog(`       Route ${routeIndex + 1}:`, {
                                nom_linia: route.nom_linia,
                                desti_trajecte: route.desti_trajecte,
                                color_linia: route.color_linia,
                                propers_trensCount: route.propers_trens?.length || 0
                            });
                            
                            // Update line color map from route data
                            if (route.nom_linia && route.color_linia) {
                                lineColorMap.set(route.nom_linia, route.color_linia);
                            }
                            
                        if (!apiLineDataMap.has(lineName)) {
                                apiLineDataMap.set(lineName, new Map());
                        }
                        
                            const destinationMap = apiLineDataMap.get(lineName);
                            const destination = route.desti_trajecte;
                            
                            if (!destinationMap.has(destination)) {
                        const lineInfoDiv = document.createElement('div');
                        lineInfoDiv.className = 'line-info';
                                lineInfoDiv.setAttribute('data-line', lineName); // Add data attribute for filtering

                        const header = document.createElement('div');
                        header.className = 'line-header';
                                header.style.backgroundColor = `#${route.color_linia || lineColor}`;
                        header.innerHTML = `
                                    <span>${route.nom_linia || lineName}</span>
                                    <span>${t('destination')} ${route.desti_trajecte}</span>
                        `;
                        lineInfoDiv.appendChild(header);

                        const trainList = document.createElement('div');
                        trainList.className = 'train-list';

                            lineInfoDiv.appendChild(trainList);
                                destinationMap.set(destination, {
                                    element: lineInfoDiv,
                                    stationCode: stationCode,
                                    color: route.color_linia || lineColor
                                });
                            }
                            
                            const trainList = destinationMap.get(destination).element.querySelector('.train-list');
                            
                                if (route.propers_trens && route.propers_trens.length > 0) {
                                debugLog(`       ✅ Found ${route.propers_trens.length} real-time train(s) for ${route.nom_linia} to ${route.desti_trajecte}`);
                                route.propers_trens.forEach((train, trainIndex) => {
                                    debugLog(`         Train ${trainIndex + 1}:`, {
                                        temps_arribada: train.temps_arribada,
                                        temps_arribada_formatted: new Date(train.temps_arribada).toLocaleString()
                                    });
                                        const trainDiv = document.createElement('div');
                                        trainDiv.className = 'train';
                                        trainDiv.innerHTML = `
                                        <span class="train-destination">${t('nextTrain')}</span>
                                        <span class="train-arrival" data-arrival-time="${train.temps_arribada}">${t('calculating')}</span>
                                        `;
                                        trainList.appendChild(trainDiv);
                                    });
                                }
                            });
                        }
                    });
                });
            
            debugLog(`\n📋 [DISPLAY] API Line Data Map created:`, Array.from(apiLineDataMap.entries()).map(([line, dests]) => ({
                line: line,
                destinations: Array.from(dests.keys())
            })));
        }
        
        // Fetch fallback data for stations that need it
        let hasFallbackData = false;
        if (stationsNeedingFallback.size > 0) {
            debugLog(`\n🔄 [DISPLAY] Fetching fallback data for ${stationsNeedingFallback.size} station(s)...`);
            const fallbackPromises = Array.from(stationsNeedingFallback).map(stationCode => 
                fetchFallbackScheduleData(stationCode)
            );
            const fallbackResults = await Promise.all(fallbackPromises);
            
            // Check if any fallback data was successfully retrieved
            hasFallbackData = fallbackResults.some(result => result && result.features && result.features.length > 0);
            
            // Process fallback data and add to display
            await processFallbackData(apiLineDataMap, allStationLines, apiData);
        }


        // Now, iterate through all known lines for the station and display the data if available.
        // This regex correctly handles all known line formats like L1, L9S, L10N, and FM.
        // Add a check to ensure allStationLines is not null or undefined.
        if (!allStationLines) {
            if (apiLineDataMap.size === 0) {
                resultsContainer.innerHTML = `<p>${t('noLineInfo')}</p>`;
            }
            return;
        }

        // The `allStationLines` is now a clean array like ['L1', 'L4'], so we can iterate directly.
        allStationLines.forEach(lineName => {
            const lineDataMap = apiLineDataMap.get(lineName);

            if (lineDataMap && lineDataMap.size > 0) {
                // Sort destinations for consistent display order
                const sortedDestinations = Array.from(lineDataMap.entries()).sort((a, b) => 
                    a[0].localeCompare(b[0])
                );
                sortedDestinations.forEach(([destination, data]) => {
                    resultsContainer.appendChild(data.element);
                });
            } else {
                // If no data from API for this line, show a placeholder box
                const placeholderDiv = document.createElement('div');
                placeholderDiv.className = 'line-info';
                placeholderDiv.setAttribute('data-line', lineName); // Add data attribute for filtering
                placeholderDiv.innerHTML = `
                        <div class="line-header" style="background-color: #808080;">
                        <span>${lineName}</span>
                        </div>
                        <div class="train-list">
                        <p>${t('noRealTimeData')}</p>
                    </div>
                `;
                resultsContainer.appendChild(placeholderDiv);
            }
        });

        // If after all checks, the container is still empty, it means no lines were found or matched.
        if (resultsContainer.innerHTML === '' && allStationLines) {
            debugLog(`\n⚠️  [DISPLAY] No data to display for any lines`);
            resultsContainer.innerHTML = `<p>${t('couldNotRetrieveData')}</p>`;
            return false; // Indicate failure
        }

        const hasData = resultsContainer.children.length > 0;
        debugLog(`\n✅ [DISPLAY] Display complete. Total line elements created: ${resultsContainer.children.length}`);

        // Find all the newly created arrival elements and start their countdowns.
        startCountdownTimers();
        
        // Return true if we have data displayed (either primary or fallback), false otherwise
        return hasData;
    }
    
    /**
     * Fetches fallback schedule data and caches it.
     * @param {string} stationCode - The station code for the API call.
     * @returns {Promise<Object|null>} The fallback API response data or null if failed.
     */
    async function fetchFallbackScheduleData(stationCode) {
        // Check cache first
        if (fallbackDataCache.has(stationCode)) {
            return fallbackDataCache.get(stationCode);
        }
        
        const apiUrl = `${FALLBACK_API_URL}?app_id=${FALLBACK_APP_ID}&app_key=${FALLBACK_APP_KEY}&transit_namespace_element=metro&codi_element=${stationCode}&transit_namespace=metro`;

        try {
            const response = await fetch(apiUrl);
            
            if (!response.ok) throw new Error('Fallback API request failed');
            
            const data = await response.json();

            // Cache the data
            fallbackDataCache.set(stationCode, data);
            return data;
        } catch (error) {
            debugLog(`[FALLBACK API] Error for station ${stationCode}:`, error.message);
            fallbackDataCache.set(stationCode, null);
            return null;
        }
    }

    /**
     * Processes fallback data and adds it to the display map.
     * @param {Map} apiLineDataMap - The map containing line data.
     * @param {string[]} allStationLines - All lines for the station.
     * @param {Object} primaryApiData - The primary API data to get line colors from.
     */
    async function processFallbackData(apiLineDataMap, allStationLines, primaryApiData) {
        debugLog(`\n🔧 [FALLBACK] Processing fallback data...`);
        
        // Create a color map from primary API data
        const lineColorMap = new Map();
        if (primaryApiData?.linies) {
            primaryApiData.linies.forEach(line => {
                const lineName = line.nom_linia || line.nom;
                if (lineName && line.color_linia) {
                    lineColorMap.set(lineName, line.color_linia);
                }
            });
        }
        
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        // Process each cached fallback response
        for (const [stationCode, data] of fallbackDataCache.entries()) {
            if (!data || !data.features) continue;
            
            debugLog(`\n   Processing station code ${stationCode}...`);
            
            // Group features by line and destination
            const groupedByLine = new Map();
            
            data.features.forEach((feature, index) => {
                const props = feature.properties;
                const lineName = props.NOM_LINIA;
                const destination = props.DESTI_TRAJECTE;
                
                if (!lineName || !destination || !props.HORES_PAS) {
                    debugLog(`     ⚠️  Skipping feature ${index + 1} - missing required data`);
                    return;
                }
                
                // Get color from primary API or use default
                const color = lineColorMap.get(lineName) || '808080';
                
                debugLog(`     Feature ${index + 1}: Line ${lineName}, Destination: ${destination}`);
                
                if (!groupedByLine.has(lineName)) {
                    groupedByLine.set(lineName, new Map());
                }
                
                const lineMap = groupedByLine.get(lineName);
                if (!lineMap.has(destination)) {
                    lineMap.set(destination, {
                        color: color,
                        stationCode: stationCode,
                        times: []
                    });
                }
                
                const timeStrings = props.HORES_PAS.split(',').filter(t => t.trim());
                const upcomingTimes = timeStrings
                    .map(timeStr => {
                        const parts = timeStr.trim().split(':');
                        if (parts.length < 2) return null;
                        const hours = parseInt(parts[0], 10);
                        const minutes = parseInt(parts[1], 10);
                        const seconds = parts.length > 2 ? parseInt(parts[2], 10) : 0;
                        
                        if (isNaN(hours) || isNaN(minutes)) return null;
                        
                        const arrivalDate = new Date(today);
                        arrivalDate.setHours(hours, minutes, seconds, 0);
                        return arrivalDate;
                    })
                    .filter(date => date !== null && date > now)
                    .sort((a, b) => a - b)
                    .slice(0, 2);
                
                lineMap.get(destination).times.push(...upcomingTimes);
            });
            
            // Add to display map
            groupedByLine.forEach((lineMap, lineName) => {
                if (!apiLineDataMap.has(lineName)) {
                    apiLineDataMap.set(lineName, new Map());
                }
                
                const destinationMap = apiLineDataMap.get(lineName);
                
                lineMap.forEach((data, destination) => {
                    if (data.times.length === 0) return;
                    
                    // Sort times and remove duplicates
                    data.times.sort((a, b) => a - b);
                    const uniqueTimes = Array.from(new Set(data.times.map(t => t.getTime())))
                        .map(t => new Date(t))
                        .sort((a, b) => a - b)
                        .slice(0, 2);
                    
                    // Only create if it doesn't already exist (to avoid duplicates)
                    if (!destinationMap.has(destination)) {
                        const lineInfoDiv = document.createElement('div');
                        lineInfoDiv.className = 'line-info';
                        lineInfoDiv.setAttribute('data-line', lineName); // Add data attribute for filtering

                        const header = document.createElement('div');
                        header.className = 'line-header';
                        header.style.backgroundColor = `#${data.color}`;
                        header.innerHTML = `
                            <span>${lineName}</span>
                            <span>${t('destination')} ${destination}</span>
                        `;
                        lineInfoDiv.appendChild(header);

                        const trainList = document.createElement('div');
                        trainList.className = 'train-list';
                        
                        uniqueTimes.forEach(arrivalTime => {
                            const trainDiv = document.createElement('div');
                            trainDiv.className = 'train';
                            trainDiv.innerHTML = `
                                <span class="train-destination">${t('scheduled')}</span>
                                <span class="train-arrival" data-arrival-time="${arrivalTime.getTime()}">${t('calculating')}</span>
                            `;
                            trainList.appendChild(trainDiv);
                        });
                        
                        lineInfoDiv.appendChild(trainList);
                        destinationMap.set(destination, {
                            element: lineInfoDiv,
                            stationCode: data.stationCode,
                            color: data.color
                        });
                        
                        debugLog(`     ✅ Created display for Line ${lineName}, Destination: ${destination} with ${uniqueTimes.length} train(s)`);
                    } else {
                        debugLog(`     ⚠️  Display already exists for Line ${lineName}, Destination: ${destination} - skipping to avoid duplicate`);
                    }
                });
            });
        }
    }

    /**
     * @deprecated - Use fetchFallbackScheduleData and processFallbackData instead
     * Fetches scheduled times from the fallback API when real-time data is unavailable.
     * @param {HTMLElement} trainListElement - The container element to populate with results.
     * @param {string} stationCode - The station code for the API call.
     */
    async function fetchFallbackSchedule(trainListElement, stationCode) {
        const apiUrl = `${FALLBACK_API_URL}?app_id=${FALLBACK_APP_ID}&app_key=${FALLBACK_APP_KEY}&transit_namespace_element=metro&codi_element=${stationCode}&transit_namespace=metro`;
        
        debugLog(`\n🔄 [FALLBACK API] Request initiated:`);
        debugLog(`   URL: ${apiUrl}`);
        debugLog(`   Station Code: ${stationCode}`);

        let foundScheduledTimes = false;

        try {
            debugLog(`\n📤 [FALLBACK API] Sending request...`);
            const response = await fetch(apiUrl);
            
            debugLog(`\n📥 [FALLBACK API] Response received:`);
            debugLog(`   Status: ${response.status} ${response.statusText}`);
            debugLog(`   Headers:`, Object.fromEntries(response.headers.entries()));
            
            if (!response.ok) throw new Error('Fallback API request failed');
            
            const data = await response.json();
            debugLog(`   ✅ Response Data:`, data);
            debugLog(`   📊 Data Structure:`, {
                hasFeatures: !!data.features,
                featuresCount: data.features?.length || 0,
                features: data.features?.map(f => ({
                    type: f.type,
                    properties: f.properties ? Object.keys(f.properties) : [],
                    hasHoresPas: !!f.properties?.HORES_PAS,
                    destination: f.properties?.DESTI_TRAJECTE
                })) || []
            });

            trainListElement.innerHTML = '';
            
            if (data.features && data.features.length > 0) {
                const now = new Date();
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

                data.features.forEach((feature) => {
                    const props = feature.properties;
                    const destination = props.DESTI_TRAJECTE;
                    
                    if (!props.HORES_PAS) {
                        return;
                    }
                    
                    const timeStrings = props.HORES_PAS.split(',').filter(t => t.trim());

                    // Find the next 2 upcoming times from the schedule
                    const upcomingTimes = timeStrings
                        .map(timeStr => {
                            const parts = timeStr.trim().split(':');
                            if (parts.length < 2) return null;
                            const hours = parseInt(parts[0], 10);
                            const minutes = parseInt(parts[1], 10);
                            const seconds = parts.length > 2 ? parseInt(parts[2], 10) : 0;
                            
                            if (isNaN(hours) || isNaN(minutes)) return null;
                            
                        const arrivalDate = new Date(today);
                        arrivalDate.setHours(hours, minutes, seconds, 0);
                        return arrivalDate;
                        })
                        .filter(date => date !== null && date > now)
                        .sort((a, b) => a - b)
                        .slice(0, 2);

                    if (upcomingTimes.length > 0) {
                        foundScheduledTimes = true;
                        upcomingTimes.forEach((arrivalTime) => {
                            const trainDiv = document.createElement('div');
                            trainDiv.className = 'train';
                            trainDiv.innerHTML = `
                                <span class="train-destination">${t('scheduled')}</span>
                                <span class="train-arrival" data-arrival-time="${arrivalTime.getTime()}">${t('calculating')}</span>
                            `;
                            trainListElement.appendChild(trainDiv);
                        });
                    }
                });
            }

            if (!foundScheduledTimes) {
                trainListElement.innerHTML = `<p>${t('noMoreDepartures')}</p>`;
            }

            startCountdownTimers();
        } catch (error) {
            debugLog(`[FALLBACK API] Error:`, error.message);
            trainListElement.innerHTML = `<p>${t('couldNotRetrieveScheduled')}</p>`;
        }
    }

    /**
     * Finds all arrival time elements and starts a countdown timer for each.
     */
    function startCountdownTimers() {
        const arrivalElements = document.querySelectorAll('.train-arrival:not([data-timer-active])');
        arrivalElements.forEach(element => {
            const arrivalTimestamp = parseInt(element.getAttribute('data-arrival-time'), 10);
            if (isNaN(arrivalTimestamp)) {
                element.textContent = t('invalidTime');
                return;
            }

            // Mark element as having an active timer to avoid duplicates
            element.setAttribute('data-timer-active', 'true');

            const updateCountdown = () => {
                const now = Date.now();
                const diffMs = arrivalTimestamp - now;

                const arrivalDate = new Date(arrivalTimestamp);
                const arrivalHours = arrivalDate.getHours().toString().padStart(2, '0');
                const arrivalMinutes = arrivalDate.getMinutes().toString().padStart(2, '0');
                const absoluteTime = `${arrivalHours}:${arrivalMinutes}`;

                if (diffMs <= 0) {
                    element.textContent = `${t('arrivingNow')} (${absoluteTime})`;
                    element.classList.add('arriving-now');
                } else {
                    const minutes = Math.floor(diffMs / 60000);
                    const seconds = Math.floor((diffMs % 60000) / 1000);
                    element.innerHTML = `${absoluteTime} <span class="countdown">(${t('in')} ${minutes}m ${seconds.toString().padStart(2, '0')}s)</span>`;
                    element.classList.remove('arriving-now');
                }
            };

            updateCountdown();
            const intervalId = setInterval(updateCountdown, 1000);
            countdownIntervalIds.push(intervalId);
        });
    }

    /**
     * Clears all active countdown intervals.
     */
    function clearCountdownTimers() {
        countdownIntervalIds.forEach(id => clearInterval(id));
        countdownIntervalIds = [];
        // Remove timer markers from elements
        document.querySelectorAll('.train-arrival[data-timer-active]').forEach(el => {
            el.removeAttribute('data-timer-active');
        });
    }

    /**
     * Shows an error message in the UI.
     * @param {string} message - The error message to display.
     */
    function showError(message) {
        if (autoRefreshIntervalId) {
            clearInterval(autoRefreshIntervalId);
            autoRefreshIntervalId = null;
        }
        clearCountdownTimers();
        timestampContainer.textContent = '';
        resultsContainer.innerHTML = '';
        if (message) {
        errorMessageDiv.textContent = message;
            errorMessageDiv.setAttribute('role', 'alert');
            errorMessageDiv.style.display = 'block';
        } else {
            errorMessageDiv.textContent = '';
            errorMessageDiv.removeAttribute('role');
            errorMessageDiv.style.display = 'none';
        }
    }

    /**
     * Gets favorites from URL hash
     * Format: #station-name&favorites=slug1,slug2,slug3
     * @returns {string[]} Array of favorite station slugs
     */
    function getFavoritesFromURL() {
        const hash = window.location.hash.replace('#', '');
        if (!hash) return [];
        
        const parts = hash.split('&');
        const favoritesPart = parts.find(part => part.startsWith('favorites='));
        if (!favoritesPart) return [];
        
        const favoritesStr = favoritesPart.replace('favorites=', '');
        return favoritesStr ? favoritesStr.split(',').filter(s => s) : [];
    }
    
    /**
     * Updates favorites in URL
     * @param {string[]} favoriteSlugs - Array of favorite station slugs
     */
    function updateFavoritesInURL(favoriteSlugs) {
        const hash = window.location.hash.replace('#', '');
        const currentStation = hash.split('&')[0]; // Get station part (before &favorites=)
        
        let newHash = '';
        if (currentStation && !currentStation.startsWith('favorites=')) {
            newHash = currentStation;
        }
        
        if (favoriteSlugs.length > 0) {
            newHash += (newHash ? '&' : '') + `favorites=${favoriteSlugs.join(',')}`;
        }
        
        const newURL = window.location.pathname + window.location.search + (newHash ? '#' + newHash : '');
        if (window.history.replaceState) {
            window.history.replaceState(null, '', newURL);
        }
    }
    
    /**
     * Loads favorites from URL and displays them
     */
    function loadFavoritesFromURL() {
        const favoriteSlugs = getFavoritesFromURL();
        if (favoriteSlugs.length > 0) {
            renderFavorites(favoriteSlugs);
        } else {
            favoritesSection.style.display = 'none';
        }
    }
    
    /**
     * Adds a station to favorites
     * @param {string} stationName - The station name to add
     */
    function addToFavorites(stationName) {
        const favoriteSlugs = getFavoritesFromURL();
        const slug = stationNameToSlug(stationName);
        
        if (!favoriteSlugs.includes(slug)) {
            favoriteSlugs.push(slug);
            updateFavoritesInURL(favoriteSlugs);
            renderFavorites(favoriteSlugs);
        }
    }
    
    /**
     * Removes a station from favorites
     * @param {string} stationSlug - The station slug to remove
     */
    function removeFromFavorites(stationSlug) {
        const favoriteSlugs = getFavoritesFromURL().filter(s => s !== stationSlug);
        updateFavoritesInURL(favoriteSlugs);
        renderFavorites(favoriteSlugs);
    }
    
    /**
     * Checks if a station is in favorites
     * @param {string} stationName - The station name to check
     * @returns {boolean} True if station is in favorites
     */
    function isFavorite(stationName) {
        const favoriteSlugs = getFavoritesFromURL();
        const slug = stationNameToSlug(stationName);
        return favoriteSlugs.includes(slug);
    }
    
    /**
     * Renders the favorites display
     * @param {string[]} favoriteSlugs - Array of favorite station slugs
     */
    function renderFavorites(favoriteSlugs) {
        if (favoriteSlugs.length === 0) {
            favoritesSection.style.display = 'none';
            return;
        }
        
        favoritesSection.style.display = 'block';
        favoritesContainer.innerHTML = '';
        
        favoriteSlugs.forEach(slug => {
            // Find station by slug
            const station = stationsList.find(s => stationNameToSlug(s.name) === slug);
            if (!station) return;
            
            const favoriteItem = document.createElement('div');
            favoriteItem.className = 'favorite-item';
            favoriteItem.setAttribute('data-slug', slug);
            
            // Get line colors for this station (sorted numerically)
            const lines = station.lines || station.customProperties?.lines || [];
            const sortedLines = lines.sort(sortLinesNumerically);
            const lineIndicators = sortedLines.map(lineName => {
                // Get color from lineColorMap, or use default gray
                const color = lineColorMap.get(lineName) || '808080';
                return `<span class="favorite-line-indicator" style="background-color: #${color}">${lineName}</span>`;
            }).join('');
            
            favoriteItem.innerHTML = `
                <div class="favorite-content">
                    <span class="favorite-name">${station.name}</span>
                    <div class="favorite-lines">${lineIndicators}</div>
                </div>
                <button class="favorite-remove" title="${t('removeFromFavorites')}" aria-label="${t('removeFromFavorites')}: ${station.name}">×</button>
            `;
            
            // Add click handler to load station
            favoriteItem.querySelector('.favorite-content').addEventListener('click', () => {
                const stationData = {
                    value: station.value || station.name,
                    label: station.label || station.name,
                    customProperties: station.customProperties || {}
                };
                
                // Update URL with selected station
                updateURL(station.name);
                
                // Update Choices.js selection and display
                if (choicesInstance) {
                    try {
                        const stationName = station.name;
                        choicesInstance.setValue([stationName]);
                        
                        // Also set the underlying select element directly
                        if (stationSelect) {
                            stationSelect.value = stationName;
                        }
                        
                        // Manually update the display element to ensure it shows
                        setTimeout(() => {
                            const singleItem = document.querySelector('.choices__item--selectable') || 
                                             document.querySelector('.choices__single .choices__item');
                            if (singleItem) {
                                singleItem.textContent = stationName;
                                debugLog(`[Favorites] Updated display element with: "${stationName}"`);
                            }
                        }, 50);
                        
                        // Retry to ensure it sticks
                        setTimeout(() => {
                            try {
                                choicesInstance.setValue([stationName]);
                                const singleItem = document.querySelector('.choices__item--selectable') || 
                                                 document.querySelector('.choices__single .choices__item');
                                if (singleItem) {
                                    singleItem.textContent = stationName;
                                }
                            } catch (e) {
                                debugLog('Could not refresh Choices.js display:', e);
                            }
                        }, 200);
                    } catch (e) {
                        debugLog('Could not update Choices.js:', e);
                    }
                }
                
                // Fetch station data after updating the display
                fetchStationData(stationData);
            });
            
            // Add remove handler
            favoriteItem.querySelector('.favorite-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromFavorites(slug);
            });
            
            favoritesContainer.appendChild(favoriteItem);
        });
    }
    
    /**
     * Updates favorites display with current station info (for line colors)
     */
    function updateFavoritesDisplay() {
        const favoriteSlugs = getFavoritesFromURL();
        if (favoriteSlugs.length === 0) return;
        
        // Update line colors using the lineColorMap
        const favoriteItems = favoritesContainer.querySelectorAll('.favorite-item');
        favoriteItems.forEach(item => {
            const slug = item.getAttribute('data-slug');
            const station = stationsList.find(s => stationNameToSlug(s.name) === slug);
            if (!station) return;
            
            const lines = station.lines || station.customProperties?.lines || [];
            const sortedLines = lines.sort(sortLinesNumerically);
            const lineIndicators = sortedLines.map(lineName => {
                // Get color from lineColorMap, or use default gray
                const color = lineColorMap.get(lineName) || '808080';
                return `<span class="favorite-line-indicator" style="background-color: #${color}">${lineName}</span>`;
            }).join('');
            
            const linesContainer = item.querySelector('.favorite-lines');
            if (linesContainer) {
                linesContainer.innerHTML = lineIndicators;
            }
        });
    }
    
    /**
     * Updates the timestamp display with the current time and line colors for multi-line stations.
     * @param {string[]} stationLines - Array of line names for the station.
     * @param {Object} apiData - The API data to extract line colors from.
     */
    function updateTimestamp(stationLines = null, apiData = null, stationNameParam = null) {
        const now = new Date();
        const options = { 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: false 
        };
        const formattedTime = now.toLocaleDateString('en-US', options).replace(',', '');
        
        // Always show refresh button, and line indicators if available
        let lineIndicatorsHTML = '';
        
        // Add line color indicators for all stations
        if (stationLines && stationLines.length > 0 && apiData) {
            const lineColors = new Map();
            
            // Extract colors from API data
            if (apiData.linies) {
                apiData.linies.forEach(line => {
                    const lineName = line.nom_linia || line.nom;
                    if (lineName && line.color_linia) {
                        lineColors.set(lineName, line.color_linia);
                    }
                });
            }
            
            // Build line indicators with click handlers (sorted numerically)
            const lineIndicators = stationLines
                .sort(sortLinesNumerically)
                .map(lineName => {
                    const color = lineColors.get(lineName) || '808080';
                    const isActive = selectedLineFilter === lineName ? 'active' : '';
                    return `<span class="line-indicator ${isActive}" data-line="${lineName}" style="background-color: #${color}" role="button" tabindex="0" aria-label="${t('filterBy')} ${lineName}">${lineName}</span>`;
                })
                .join('');
            
            if (lineIndicators) {
                lineIndicatorsHTML = `<div class="line-indicators">${lineIndicators}</div>`;
            }
        }
        
        // Get current station name from parameter first (most reliable), then from Choices.js
        let currentStationName = stationNameParam || '';
        if (!currentStationName && choicesInstance) {
            const selectedItem = choicesInstance.getValue();
            if (selectedItem) {
                if (typeof selectedItem === 'string') {
                    currentStationName = selectedItem;
                } else if (selectedItem.value) {
                    currentStationName = selectedItem.value;
                } else if (selectedItem.label) {
                    currentStationName = selectedItem.label;
                }
            }
        }
        
        const isFav = currentStationName && isFavorite(currentStationName);
        const favoriteBtnHTML = currentStationName ? `
            <button id="favorite-btn" class="favorite-btn ${isFav ? 'active' : ''}" 
                    title="${isFav ? t('removeFromFavorites') : t('addToFavorites')}" 
                    aria-label="${isFav ? t('removeFromFavorites') : t('addToFavorites')}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
            </button>
        ` : '';
        
        // Always include refresh button and favorite button
        // Wrap line indicators on left, buttons on right
        const timestampHTML = `
            <div class="timestamp-content">
                <span>${t('lastUpdated')} ${formattedTime}</span>
                <div class="line-indicators-wrapper">
                    <div class="line-indicators-left">
                        ${lineIndicatorsHTML}
                    </div>
                    <div class="buttons-right">
                        ${favoriteBtnHTML}
                        <button id="refresh-btn" class="refresh-btn" title="${t('refresh')}" aria-label="${t('refreshAria')}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        timestampContainer.innerHTML = timestampHTML;
        
        // Attach event listeners for line indicator clicks (filter by line)
        const lineIndicatorElements = timestampContainer.querySelectorAll('.line-indicator');
        lineIndicatorElements.forEach(indicator => {
            indicator.addEventListener('click', () => {
                const lineName = indicator.getAttribute('data-line');
                filterByLine(lineName);
            });
            
            // Keyboard accessibility
            indicator.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const lineName = indicator.getAttribute('data-line');
                    filterByLine(lineName);
                }
            });
        });
        
        // Add refresh button event listener if it exists
        const refreshBtn = document.getElementById('refresh-btn');
        if (refreshBtn) {
            // Remove any existing listeners by cloning the button
            const newRefreshBtn = refreshBtn.cloneNode(true);
            refreshBtn.parentNode.replaceChild(newRefreshBtn, refreshBtn);
            
            newRefreshBtn.addEventListener('click', () => {
                // First, try to get station from URL (most reliable)
                const hash = window.location.hash.replace('#', '');
                if (hash) {
                    const slug = hash.split('&')[0];
                    const stationName = slugToStationName(slug, stationsList.map(s => ({ name: s.name })));
                    if (stationName) {
                        const stationData = stationsList.find(s => s.name === stationName);
                        if (stationData) {
                            const dataToPass = {
                                value: stationData.value || stationData.name,
                                label: stationData.label || stationData.name,
                                        customProperties: stationData.customProperties || {}
                                    };
                            debugLog('[Refresh] Using station from URL:', stationName);
                            fetchStationData(dataToPass);
                            return;
                        }
                    }
                }
                
                // Fallback: try to get from Choices.js
                if (choicesInstance) {
                    const selectedItem = choicesInstance.getValue();
                    if (selectedItem) {
                        let stationName = null;
                        if (typeof selectedItem === 'string') {
                            stationName = selectedItem;
                        } else if (selectedItem.value) {
                            stationName = selectedItem.value;
                        } else if (selectedItem.label) {
                            stationName = selectedItem.label;
                        }
                        
                        if (stationName) {
                            const stationData = stationsList.find(s => s.name === stationName);
                            if (stationData) {
                                const dataToPass = {
                                    value: stationData.value || stationData.name,
                                    label: stationData.label || stationData.name,
                                    customProperties: stationData.customProperties || {}
                                };
                                debugLog('[Refresh] Using station from Choices.js:', stationName);
                                fetchStationData(dataToPass);
                                return;
                            }
                        }
                    }
                }
                
                // If nothing works, show error
                debugLog('[Refresh] No station found');
                showError(t('pleaseSelectStation'));
            });
        }
        
        // Add favorite button event listener if it exists
        const favoriteBtn = document.getElementById('favorite-btn');
        if (favoriteBtn && currentStationName) {
            const newFavoriteBtn = favoriteBtn.cloneNode(true);
            favoriteBtn.parentNode.replaceChild(newFavoriteBtn, favoriteBtn);
            
            newFavoriteBtn.addEventListener('click', () => {
                if (isFavorite(currentStationName)) {
                    const slug = stationNameToSlug(currentStationName);
                    removeFromFavorites(slug);
                } else {
                    addToFavorites(currentStationName);
                }
                // Update timestamp to refresh button state (pass currentStationName from scope)
                updateTimestamp(stationLines, apiData, currentStationName);
            });
        }
        timestampContainer.setAttribute('datetime', now.toISOString());
    }

    /**
     * Filters the displayed train results by line
     * @param {string} lineName - The line name to filter by (null to show all)
     */
    function filterByLine(lineName) {
        // Toggle: if clicking the same line, clear filter
        if (selectedLineFilter === lineName) {
            selectedLineFilter = null;
        } else {
            selectedLineFilter = lineName;
        }
        
        // Get all line-info elements
        const allLineInfos = resultsContainer.querySelectorAll('.line-info');
        
        // Show/hide based on filter
        allLineInfos.forEach(lineInfo => {
            const lineData = lineInfo.getAttribute('data-line');
            if (selectedLineFilter === null) {
                // Show all lines
                lineInfo.style.display = '';
            } else {
                // Show only selected line
                lineInfo.style.display = lineData === selectedLineFilter ? '' : 'none';
            }
        });
        
        // Update line indicator active states
        const lineIndicators = timestampContainer.querySelectorAll('.line-indicator');
        lineIndicators.forEach(indicator => {
            const indicatorLine = indicator.getAttribute('data-line');
            if (selectedLineFilter === indicatorLine) {
                indicator.classList.add('active');
            } else {
                indicator.classList.remove('active');
            }
        });
    }

    /**
     * Copies the current page URL to clipboard
     */
    function copyLinkToClipboard() {
        const url = window.location.href;
        
        // Use modern Clipboard API if available
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
                showCopyFeedback();
            }).catch(err => {
                debugLog('Failed to copy:', err);
                fallbackCopyTextToClipboard(url);
            });
        } else {
            // Fallback for older browsers
            fallbackCopyTextToClipboard(url);
        }
    }

    /**
     * Fallback method to copy text to clipboard
     */
    function fallbackCopyTextToClipboard(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                showCopyFeedback();
            } else {
                debugLog('Fallback copy failed');
            }
        } catch (err) {
            debugLog('Fallback copy error:', err);
        }
        
        document.body.removeChild(textArea);
    }

    /**
     * Shows visual feedback when link is copied
     */
    function showCopyFeedback() {
        const btn = document.getElementById('copy-link-btn');
        if (!btn) return;
        
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        btn.classList.add('copied');
        
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.classList.remove('copied');
        }, 2000);
    }

    // --- Initialization ---
    // Check if there's a hash in the URL on initial load
    const hasInitialHash = window.location.hash && window.location.hash.length > 1;
    
    // Initialize language from URL
    currentLanguage = getLanguageFromURL();
    document.documentElement.lang = currentLanguage;
    if (languageSelect) {
        languageSelect.value = currentLanguage;
        languageSelect.addEventListener('change', (e) => {
            changeLanguage(e.target.value);
        });
    }
    
    // Initial translation update
    updateTranslations();
    
    loadStations();
    
    // If there's a hash on initial load, make sure we try to load it after stations are ready
    if (hasInitialHash) {
        // Try loading from URL after a short delay to ensure stations are loaded
        setTimeout(() => {
            loadStationFromURL();
        }, 500);
    }
    
    // Add event listener to the Choices.js instance
    // The 'choice' event passes a CustomEvent with detail containing the choice data
    stationSelect.addEventListener('choice', (event) => {
        debugLog('[Event] Choice event received:', event);
        
        // Extract the choice data from the CustomEvent
        let choiceData = null;
        
        if (event.detail) {
            // Choices.js passes choice data in event.detail
            if (event.detail.customProperties) {
                choiceData = {
                    value: event.detail.value || event.detail.label,
                    label: event.detail.label || event.detail.value,
                    customProperties: event.detail.customProperties || {}
                };
            } else if (event.detail.value || event.detail.label) {
                // If no customProperties, look it up from stationsList
                const stationName = event.detail.value || event.detail.label;
                const fullStationData = stationsList.find(s => s.name === stationName);
                if (fullStationData) {
                    choiceData = {
                        value: fullStationData.value || fullStationData.name,
                        label: fullStationData.label || fullStationData.name,
                        customProperties: fullStationData.customProperties || {}
                    };
                }
            }
        }
        
        if (choiceData && choiceData.customProperties && choiceData.customProperties.apiCodes) {
            debugLog(`[Event] Station selected: ${choiceData.value} (${choiceData.customProperties.apiCodes.length} API code(s))`);
            fetchStationData(choiceData);
        } else {
            // Fallback: try to get from Choices.js getValue()
            debugLog('[Event] Could not extract from event, using Choices.js getValue()');
            setTimeout(() => {
                fetchStationData();
            }, 100);
        }
    });
    
    // Add copy link button event listener
    const copyLinkBtn = document.getElementById('copy-link-btn');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', copyLinkToClipboard);
    }
    
    // Handle browser back/forward buttons and hash changes
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.station) {
            // Station was in state, try to load it
            if (choicesInstance) {
                choicesInstance.setValueByChoice(event.state.station);
                fetchStationData();
            }
        } else {
            // Check if there's a hash in the URL
            loadStationFromURL();
        }
    });
    
    // Also listen for hash changes (when user clicks back/forward or link changes hash)
    window.addEventListener('hashchange', () => {
        loadStationFromURL();
    });
});
