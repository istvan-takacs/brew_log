// Import Firebase SDK from CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { 
    getFirestore, 
    collection, 
    addDoc, 
    query, 
    orderBy, 
    getDocs,
    where,
    deleteDoc,
    doc,
    Timestamp 
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// Import your Firebase config
import { firebaseConfig } from './firebase-config.js';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Constants
const COLLECTION_NAME = 'brews';

// Bean type configurations
const BEAN_CONFIGS = {
    House: {
        minTime: 26,
        maxTime: 30,
        placeholder: '28'
    },
    Decaf: {
        minTime: 24,
        maxTime: 28,
        placeholder: '26'
    }
};

// State
let currentFilter = 'today';
let selectedBeanType = 'House'; // Default to House
let selectedLocation = 'Shoreditch'; // Default location
let isGlobalView = false; // Track if viewing all locations
let allBrewsCache = []; // Cache to avoid re-fetching

// DOM Elements
const form = document.getElementById('brew-log');
const tableBody = document.getElementById('brew-table-body');
const toast = document.getElementById('toast');
const celebration = document.getElementById('celebration');
const filterTabs = document.querySelectorAll('.filter-tab');
const beanButtons = document.querySelectorAll('.bean-btn');
const timeInput = document.getElementById('time');
const statTotal = document.getElementById('stat-total');
const statShowing = document.getElementById('stat-showing');
const statStreak = document.getElementById('stat-streak');
const locationTabs = document.querySelectorAll('.location-tab');
const logSection = document.querySelector('.log');
const contentsDiv = document.querySelector('.contents');
const tableHeaderRow = document.getElementById('table-header-row');
const toggleFormBtn = document.getElementById('toggle-form');
const formContent = document.getElementById('form-content');

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    // Restore last selected location from localStorage
    const savedLocation = localStorage.getItem('selectedLocation');
    if (savedLocation && savedLocation !== 'all') {
        selectedLocation = savedLocation;
        isGlobalView = false;
    }
    
    updateLocationTabs();
    loadAndRenderBrews();
    form.addEventListener('submit', handleSubmit);
    setupFilterTabs();
    setupBeanSelector();
    setupLocationTabs();
    setupFormToggle();
    updateTimeInputLimits(); // Set initial limits for House
});

/**
 * Setup form collapse/expand toggle (mobile only)
 */
function setupFormToggle() {
    if (toggleFormBtn) {
        toggleFormBtn.addEventListener('click', () => {
            formContent.classList.toggle('collapsed');
            const icon = toggleFormBtn.querySelector('.toggle-icon');
            icon.textContent = formContent.classList.contains('collapsed') ? '+' : '−';
        });
    }
}

/**
 * Setup bean type selector
 */
function setupBeanSelector() {
    beanButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active state
            beanButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Update selected bean type
            selectedBeanType = btn.dataset.bean;
            
            // Update time input limits
            updateTimeInputLimits();
        });
    });
}

/**
 * Update time input min/max based on selected bean type
 */
function updateTimeInputLimits() {
    const config = BEAN_CONFIGS[selectedBeanType];
    timeInput.min = config.minTime;
    timeInput.max = config.maxTime;
    timeInput.placeholder = config.placeholder;
}

/**
 * Calculate shift based on hour of day
 * AM: 7:00 - 14:59
 * PM: 15:00 - 22:59
 * Night: 23:00 - 6:59 (uses start date - when shift begins at 11pm)
 */
function calculateShift(date) {
    const hour = date.getHours();
    
    if (hour >= 7 && hour < 15) {
        return 'AM';
    } else if (hour >= 15 && hour < 23) {
        return 'PM';
    } else {
        return 'Night';
    }
}

/**
 * Get shift identifier for grouping
 * Format: "YYYY-MM-DD-SHIFT"
 * Night shift uses start date (when it begins at 11pm)
 */
function getShiftIdentifier(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const shift = calculateShift(d);
    
    return `${year}-${month}-${day}-${shift}`;
}

/**
 * Get display date for shift group
 */
function getShiftDisplayDate(shiftId) {
    const [year, month, day, shift] = shiftId.split('-');
    const date = new Date(year, parseInt(month) - 1, parseInt(day));
    
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const isToday = date.toDateString() === today.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();
    
    let dateStr;
    if (isToday) {
        dateStr = 'Today';
    } else if (isYesterday) {
        dateStr = 'Yesterday';
    } else {
        dateStr = date.toLocaleDateString('en-GB', {
            weekday: 'short',
            day: '2-digit',
            month: 'short'
        });
    }
    
    return `${dateStr} - ${shift} Shift`;
}

/**
 * Format timestamp for display
 * Shows "HH:MM" for items within shift groups
 */
function formatTimestamp(date) {
    const brewDate = new Date(date);
    return brewDate.toLocaleTimeString('en-GB', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

/**
 * Check if a brew already exists for this shift and bean type (at current location)
 */
async function checkDuplicateBrew(beanType, shiftId) {
    const existingBrew = allBrewsCache.find(brew => {
        const brewShiftId = getShiftIdentifier(brew.timestamp);
        return brew.location === selectedLocation && 
               brewShiftId === shiftId && 
               brew.beanType === beanType;
    });
    
    return existingBrew;
}

/**
 * Save brew to Firestore
 */
async function saveBrew(brewData) {
    try {
        await addDoc(collection(db, COLLECTION_NAME), brewData);
        console.log('✅ Brew saved to Firestore');
    } catch (error) {
        console.error('❌ Error saving brew:', error);
        alert('Failed to save brew. Check console for details.');
    }
}

/**
 * Update existing brew
 */
async function updateBrew(brewId, brewData) {
    try {
        await deleteDoc(doc(db, COLLECTION_NAME, brewId));
        await addDoc(collection(db, COLLECTION_NAME), brewData);
        console.log('✅ Brew updated in Firestore');
    } catch (error) {
        console.error('❌ Error updating brew:', error);
        alert('Failed to update brew. Check console for details.');
    }
}

/**
 * Load brews from Firestore (filtered by location if not in global view)
 */
async function loadBrews() {
    try {
        let q;
        
        if (isGlobalView) {
            // Global view - get all brews from all locations
            q = query(
                collection(db, COLLECTION_NAME),
                orderBy('timestamp', 'desc')
            );
        } else {
            // Location-specific view - filter by selected location
            q = query(
                collection(db, COLLECTION_NAME),
                where('location', '==', selectedLocation),
                orderBy('timestamp', 'desc')
            );
        }
        
        const querySnapshot = await getDocs(q);
        const brews = [];
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const timestamp = data.timestamp.toDate();
            brews.push({
                id: doc.id,
                location: data.location,
                extractionWeight: data.extractionWeight,
                extractionTime: data.extractionTime,
                grindTime: data.grindTime,
                beanType: data.beanType,
                timestamp: timestamp.toISOString(),
                // Always recalculate shift from timestamp (don't trust stored value)
                shift: calculateShift(timestamp)
            });
        });
        
        console.log(`📊 Loaded ${brews.length} brews from Firestore`);
        return brews;
    } catch (error) {
        console.error('❌ Error loading brews:', error);
        return [];
    }
}

/**
 * Group brews by shift
 */
function groupBrewsByShift(brews) {
    const groups = {};
    
    brews.forEach(brew => {
        const shiftId = getShiftIdentifier(brew.timestamp);
        if (!groups[shiftId]) {
            groups[shiftId] = [];
        }
        groups[shiftId].push(brew);
    });
    
    return groups;
}

/**
 * Calculate streak (consecutive complete shifts)
 * A complete shift = both House AND Decaf logged
 */
function calculateStreak(allBrews) {
    const groups = groupBrewsByShift(allBrews);
    
    // Sort shift IDs in reverse chronological order
    const sortedShiftIds = Object.keys(groups).sort().reverse();
    
    let streak = 0;
    
    for (const shiftId of sortedShiftIds) {
        const brews = groups[shiftId];
        const hasHouse = brews.some(b => b.beanType === 'House');
        const hasDecaf = brews.some(b => b.beanType === 'Decaf');
        
        // Both beans logged = complete shift
        if (hasHouse && hasDecaf) {
            streak++;
        } else {
            // Streak broken - stop counting
            break;
        }
    }
    
    return streak;
}

/**
 * Check if shift was just completed (both beans now logged)
 */
function wasShiftJustCompleted(shiftId, newBeanType) {
    const shiftBrews = allBrewsCache.filter(brew => 
        getShiftIdentifier(brew.timestamp) === shiftId
    );
    
    // Check if OTHER bean type already exists
    const hasOtherBean = shiftBrews.some(brew => brew.beanType !== newBeanType);
    
    return hasOtherBean;
}

/**
 * Update table header based on view mode
 */
function updateTableHeader() {
    // Check if location header already exists
    const hasLocationHeader = tableHeaderRow.querySelector('.location-header');
    
    if (isGlobalView && !hasLocationHeader) {
        // Add location column header (after Bean)
        const beanHeader = tableHeaderRow.querySelector('th:nth-child(3)');
        const locationHeader = document.createElement('th');
        locationHeader.className = 'location-header';
        locationHeader.textContent = 'Location';
        beanHeader.insertAdjacentElement('afterend', locationHeader);
    } else if (!isGlobalView && hasLocationHeader) {
        // Remove location column header
        hasLocationHeader.remove();
    }
}

/**
 * Render brews table with shift grouping
 */
function renderTable(brews) {
    // Update table header
    updateTableHeader();
    
    // Clear existing rows
    tableBody.innerHTML = '';
    
    const colspan = isGlobalView ? 7 : 6;
    
    if (brews.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="${colspan}" class="empty-state">
                    <p>No brews logged yet. Start logging to see your history!</p>
                </td>
            </tr>
        `;
        return;
    }
    
    // Group brews by shift
    const groups = groupBrewsByShift(brews);
    const sortedShiftIds = Object.keys(groups).sort().reverse();
    
    // Render each group
    sortedShiftIds.forEach(shiftId => {
        // Add shift group header
        const headerRow = document.createElement('tr');
        headerRow.className = 'shift-group-header';
        headerRow.innerHTML = `
            <td colspan="${colspan}">${getShiftDisplayDate(shiftId)}</td>
        `;
        tableBody.appendChild(headerRow);
        
        // Add brews in this shift (sort by bean type: House first, then Decaf)
        const shiftBrews = groups[shiftId].sort((a, b) => {
            if (a.beanType === 'House' && b.beanType === 'Decaf') return -1;
            if (a.beanType === 'Decaf' && b.beanType === 'House') return 1;
            return 0;
        });
        
        shiftBrews.forEach(brew => {
            const row = document.createElement('tr');
            
            // Add class for mobile card layout with location
            if (isGlobalView) {
                row.classList.add('has-location');
            }
            
            // Timestamp cell (left side)
            const timeCell = document.createElement('td');
            timeCell.className = 'brew-time';
            timeCell.textContent = formatTimestamp(brew.timestamp);
            row.appendChild(timeCell);
            
            // Content cell (right side) - wraps badges and details
            const contentCell = document.createElement('td');
            contentCell.className = 'brew-content';
            
            // Badges container
            const badgesDiv = document.createElement('div');
            badgesDiv.className = 'brew-badges';
            badgesDiv.innerHTML = `
                <span class="shift-badge shift-${brew.shift}">${brew.shift}</span>
                <span class="bean-badge bean-${brew.beanType}">${brew.beanType}</span>
                ${isGlobalView ? `<span class="location-badge location-${brew.location}">${brew.location}</span>` : ''}
            `;
            contentCell.appendChild(badgesDiv);
            
            // Details container
            const detailsDiv = document.createElement('div');
            detailsDiv.className = 'brew-details';
            detailsDiv.innerHTML = `
                <span>${brew.extractionWeight}g</span>
                <span>${brew.extractionTime}s</span>
                <span>${brew.grindTime}s</span>
            `;
            contentCell.appendChild(detailsDiv);
            
            row.appendChild(contentCell);
            tableBody.appendChild(row);
        });
    });
}

/**
 * Filter brews by time period
 */
function filterBrews(brews, filter) {
    const now = new Date();
    
    switch(filter) {
        case 'today':
            return brews.filter(brew => {
                const brewDate = new Date(brew.timestamp);
                return brewDate.toDateString() === now.toDateString();
            });
        
        case 'week':
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return brews.filter(brew => {
                const brewDate = new Date(brew.timestamp);
                return brewDate >= weekAgo;
            });
        
        case 'all':
        default:
            return brews;
    }
}

/**
 * Update statistics display
 */
function updateStats(totalBrews, filteredBrews, streak) {
    statTotal.textContent = totalBrews;
    statShowing.textContent = filteredBrews;
    
    // Only show streak in location-specific view
    if (isGlobalView) {
        statStreak.textContent = '—';
    } else {
        statStreak.textContent = streak > 0 ? `🔥 ${streak}` : '—';
    }
}

/**
 * Load and render brews from Firestore
 */
async function loadAndRenderBrews() {
    allBrewsCache = await loadBrews();
    const filteredBrews = filterBrews(allBrewsCache, currentFilter);
    const streak = calculateStreak(allBrewsCache);
    
    renderTable(filteredBrews);
    updateStats(allBrewsCache.length, filteredBrews.length, streak);
}

/**
 * Update location tabs to show active state
 */
function updateLocationTabs() {
    locationTabs.forEach(tab => {
        const tabLocation = tab.dataset.location;
        if (isGlobalView && tabLocation === 'all') {
            tab.classList.add('active');
        } else if (!isGlobalView && tabLocation === selectedLocation) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    
    // Update UI based on view mode
    if (isGlobalView) {
        logSection.style.display = 'none';
        contentsDiv.classList.add('global-view');
    } else {
        logSection.style.display = 'block';
        contentsDiv.classList.remove('global-view');
    }
}

/**
 * Setup location tab event listeners
 */
function setupLocationTabs() {
    locationTabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            const location = tab.dataset.location;
            
            if (location === 'all') {
                // Switch to global view
                isGlobalView = true;
                selectedLocation = null;
            } else {
                // Switch to specific location
                isGlobalView = false;
                selectedLocation = location;
                
                // Persist location preference
                localStorage.setItem('selectedLocation', selectedLocation);
                
                // Reset form
                form.reset();
            }
            
            // Update tab UI
            updateLocationTabs();
            
            // Reload data
            await loadAndRenderBrews();
        });
    });
}

/**
 * Setup filter tab event listeners
 */
function setupFilterTabs() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Update active state
            filterTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update current filter
            currentFilter = tab.dataset.filter;
            
            // Re-render with cached data (no need to re-fetch)
            const filteredBrews = filterBrews(allBrewsCache, currentFilter);
            const streak = calculateStreak(allBrewsCache);
            renderTable(filteredBrews);
            updateStats(allBrewsCache.length, filteredBrews.length, streak);
        });
    });
}

/**
 * Handle form submission
 */
async function handleSubmit(e) {
    e.preventDefault();
    
    // Get form values
    const weight = parseFloat(document.getElementById('weight').value);
    const time = parseFloat(document.getElementById('time').value);
    const grind = parseFloat(document.getElementById('grind').value);
    
    // Create brew data object
    const now = new Date();
    const shiftId = getShiftIdentifier(now);
    
    // Check for duplicate
    const existingBrew = await checkDuplicateBrew(selectedBeanType, shiftId);
    
    if (existingBrew) {
        const overwrite = confirm(
            `${selectedBeanType} brew already logged for ${calculateShift(now)} shift.\n\nOverwrite existing entry?`
        );
        
        if (!overwrite) {
            return;
        }
    }
    
    const brewData = {
        location: selectedLocation,
        extractionWeight: weight,
        extractionTime: time,
        grindTime: grind,
        timestamp: Timestamp.fromDate(now),
        shift: calculateShift(now),
        beanType: selectedBeanType
    };
    
    // Save or update
    if (existingBrew) {
        await updateBrew(existingBrew.id, brewData);
    } else {
        await saveBrew(brewData);
    }
    
    // Check if shift was just completed
    const shiftCompleted = wasShiftJustCompleted(shiftId, selectedBeanType);
    
    // Reload data from Firestore
    await loadAndRenderBrews();
    
    // Calculate new streak
    const newStreak = calculateStreak(allBrewsCache);
    
    // Reset form
    form.reset();
    
    // Focus back on first input
    document.getElementById('weight').focus();
    
    // Show success toast with streak info
    if (shiftCompleted && newStreak > 0) {
        showCelebration();
        showToast(`Brew logged! 🔥 ${newStreak}-shift streak!`);
    } else if (newStreak > 0) {
        showToast(`Brew logged! ☕ 🔥 ${newStreak}`);
    } else {
        showToast('Brew logged! ☕');
    }
}

/**
 * Show celebration animation
 */
function showCelebration() {
    celebration.classList.remove('hidden');
    celebration.classList.add('show');
    
    setTimeout(() => {
        celebration.classList.remove('show');
        setTimeout(() => {
            celebration.classList.add('hidden');
        }, 500);
    }, 1000);
}

/**
 * Show success toast notification
 */
function showToast(message = 'Brew logged! ☕') {
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Keyboard shortcut: Press Enter to submit from any input
document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            form.requestSubmit();
        }
    });
});
