// Import Firebase SDK from CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
    getFirestore,
    collection,
    addDoc,
    query,
    orderBy,
    onSnapshot,
    where,
    deleteDoc,
    doc,
    getDocs,
    Timestamp,
    writeBatch,
    limit as firestoreLimit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

import { getAuth, signInAnonymously } from
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

// Import your Firebase config
import { firebaseConfig } from './firebase-config.js';

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore
const db = getFirestore(app);

// Initialize Auth
const auth = getAuth(app);

/**
 * Sign in anonymously. Returns a promise that resolves when auth is ready.
 * This blocks Firestore reads behind a valid auth token so bots that
 * don't execute JS can't hit the database.
 */
async function ensureAuth() {
    if (auth.currentUser) return auth.currentUser;

    try {
        const credential = await signInAnonymously(auth);
        console.log('✅ Signed in anonymously:', credential.user.uid);
        return credential.user;
    } catch (error) {
        console.error('❌ Anonymous auth failed:', error);
        showError('Authentication failed. Please refresh the page.');
        throw error;
    }
}

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
let allBrewsCache = []; // Current brew data (kept live by onSnapshot)
let activeUnsubscribe = null; // Current onSnapshot unsubscribe function
let snapshotPromise = null;   // { resolve } — for post-write await

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
const errorToast = document.getElementById('error-toast');
const offlineBanner = document.getElementById('offline-banner');
const refreshIndicator = document.getElementById('refresh-indicator');
const loadingSkeleton = document.getElementById('loading-skeleton');
const brewTable = document.getElementById('brew-table');
const confirmModal = document.getElementById('confirm-modal');
const modalMessage = document.getElementById('modal-message');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const submitBtn = document.getElementById('submit-btn');
const btnText = submitBtn.querySelector('.btn-text');
const btnSpinner = submitBtn.querySelector('.btn-spinner');
const weightInput = document.getElementById('weight');
const grindInput = document.getElementById('grind');
const weightHint = document.getElementById('weight-hint');
const timeHint = document.getElementById('time-hint');
const grindHint = document.getElementById('grind-hint');
const shiftStatusEl = document.getElementById('shift-status');
const statShowingLabel = document.getElementById('stat-showing-label');

// Filter label map
const FILTER_LABELS = {
    today: 'Today',
    week: 'This Week',
    all: 'All Time'
};

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 App initializing...');

    // Ensure skeleton is hidden on load
    loadingSkeleton.classList.add('hidden');
    brewTable.style.display = '';

    // Ensure refresh indicator is hidden
    refreshIndicator.classList.add('hidden');

    // Ensure offline banner is hidden initially
    if (navigator.onLine) {
        offlineBanner.classList.add('hidden');
    }

    // Restore last selected location from localStorage
    const savedLocation = localStorage.getItem('selectedLocation');
    if (savedLocation && savedLocation !== 'all') {
        selectedLocation = savedLocation;
        isGlobalView = false;
    }

    updateLocationTabs();

    // Setup network status monitoring
    setupNetworkMonitoring();

    // Setup pull-to-refresh
    setupPullToRefresh();

    // Setup modal
    setupModal();

    // Setup form validation
    setupFormValidation();

    // Authenticate before loading any data
    await ensureAuth();

    subscribeToBrew();
    form.addEventListener('submit', handleSubmit);
    setupFilterTabs();
    setupBeanSelector();
    setupLocationTabs();
    setupFormToggle();
    updateTimeInputLimits(); // Set initial limits for House

    // Register service worker for PWA support
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/sw.js');
            console.log('✅ Service worker registered:', registration.scope);
        } catch (error) {
            console.error('❌ Service worker registration failed:', error);
        }
    }
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
 * Show loading skeleton
 */
function showLoading() {
    console.log('🔄 Showing loading skeleton');
    loadingSkeleton.classList.remove('hidden');
    brewTable.style.display = 'none';
}

/**
 * Hide loading skeleton
 */
function hideLoading() {
    console.log('✅ Hiding loading skeleton');
    loadingSkeleton.classList.add('hidden');
    brewTable.style.display = ''; // Reset to default (table)
}

/**
 * Show error toast
 */
function showError(message) {
    errorToast.textContent = message;
    errorToast.classList.add('show');
    setTimeout(() => {
        errorToast.classList.remove('show');
    }, 5000);
}

/**
 * Setup network status monitoring
 */
function setupNetworkMonitoring() {
    window.addEventListener('online', () => {
        offlineBanner.classList.add('hidden');
        showToast('Back online! ✅');
        subscribeToBrew(); // Resubscribe to get fresh data
    });
    
    window.addEventListener('offline', () => {
        offlineBanner.classList.remove('hidden');
    });
    
    // Check initial state
    if (!navigator.onLine) {
        offlineBanner.classList.remove('hidden');
    }
}

/**
 * Setup pull-to-refresh
 */
let pullStartY = 0;
let isPulling = false;

function setupPullToRefresh() {
    let pullDistance = 0;
    
    document.addEventListener('touchstart', (e) => {
        if (window.scrollY === 0) {
            pullStartY = e.touches[0].pageY;
            isPulling = true;
        }
    });
    
    document.addEventListener('touchmove', (e) => {
        if (!isPulling) return;
        
        const currentY = e.touches[0].pageY;
        pullDistance = currentY - pullStartY;
        
        if (pullDistance > 80) {
            refreshIndicator.classList.remove('hidden');
        }
    });
    
    document.addEventListener('touchend', async () => {
        if (isPulling && pullDistance > 80) {
            refreshIndicator.classList.remove('hidden');
            try {
                subscribeToBrew();
                showToast('Refreshed! ✅');
                triggerHaptic();
            } catch (error) {
                showError('Failed to refresh');
            } finally {
                setTimeout(() => {
                    refreshIndicator.classList.add('hidden');
                }, 500);
            }
        }
        isPulling = false;
        pullDistance = 0;
    });
}

/**
 * Trigger haptic feedback (iOS)
 */
function triggerHaptic() {
    if (navigator.vibrate) {
        navigator.vibrate(50);
    }
}

/**
 * Setup confirmation modal
 */
let modalResolve = null;

function setupModal() {
    if (!confirmModal || !modalCancel || !modalConfirm || !modalMessage) {
        console.error('❌ Modal elements not found!');
        return;
    }
    
    console.log('✅ Modal setup complete');
    
    modalCancel.addEventListener('click', () => {
        console.log('❌ Cancel button clicked');
        if (modalResolve) {
            modalResolve(false);
            modalResolve = null;
        }
        closeModal();
    });
    
    modalConfirm.addEventListener('click', () => {
        console.log('✅ Confirm button clicked');
        if (modalResolve) {
            modalResolve(true);
            modalResolve = null;
        }
        closeModal();
    });
    
    // Close on overlay click
    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal || e.target.classList.contains('modal-overlay')) {
            console.log('❌ Overlay clicked');
            if (modalResolve) {
                modalResolve(false);
                modalResolve = null;
            }
            closeModal();
        }
    });
}

function showModal(message) {
    return new Promise((resolve) => {
        console.log('🔔 Showing modal:', message);
        modalMessage.innerHTML = message;
        confirmModal.classList.remove('hidden');
        // Force display in case CSS isn't working
        confirmModal.style.display = 'flex';
        modalResolve = resolve;
    });
}

function closeModal() {
    console.log('❌ Closing modal');
    confirmModal.classList.add('hidden');
    confirmModal.style.display = 'none';
    // Don't set modalResolve to null here - it's already handled in the button handlers
}

/**
 * Setup form validation
 */
function setupFormValidation() {
    // Weight validation
    weightInput.addEventListener('blur', () => {
        if (weightInput.value && (parseFloat(weightInput.value) < 18.5 || parseFloat(weightInput.value) > 19.5)) {
            weightHint.classList.remove('hidden');
        } else {
            weightHint.classList.add('hidden');
        }
    });
    
    weightInput.addEventListener('input', () => {
        if (weightInput.value && parseFloat(weightInput.value) >= 18.5 && parseFloat(weightInput.value) <= 19.5) {
            weightHint.classList.add('hidden');
        }
    });
    
    // Time validation (dynamic based on bean type)
    timeInput.addEventListener('blur', () => {
        const config = BEAN_CONFIGS[selectedBeanType];
        const value = parseInt(timeInput.value);
        const coarseFine = value > config.maxTime ? "coarser" : "finer";
        if (timeInput.value && (value < config.minTime || value > config.maxTime)) {
            timeHint.textContent = `Must be between ${config.minTime}-${config.maxTime}s. Try adjusting the grinder wheel to make it ${coarseFine}.`;
            timeHint.classList.remove('hidden');
        }
        else {
            timeHint.classList.add('hidden');
        }
    });
    
    timeInput.addEventListener('input', () => {
        const config = BEAN_CONFIGS[selectedBeanType];
        const value = parseInt(timeInput.value);
        if (timeInput.value && value >= config.minTime && value <= config.maxTime) {
            timeHint.classList.add('hidden');
        }
    });
    
    // Grind validation
    grindInput.addEventListener('blur', () => {
        if (grindInput.value && (parseFloat(grindInput.value) < 3 || parseFloat(grindInput.value) > 15)) {
            grindHint.classList.remove('hidden');
        } else {
            grindHint.classList.add('hidden');
        }
    });
    
    grindInput.addEventListener('input', () => {
        if (grindInput.value && parseFloat(grindInput.value) >= 3 && parseFloat(grindInput.value) <= 15) {
            grindHint.classList.add('hidden');
        }
    });
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
            
            // Update time input limits and hint text
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
    
    // Update hint text to show correct range
    timeHint.textContent = `Must be between ${config.minTime}-${config.maxTime}s`;
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
 * Night shift uses start date (when it begins at 11pm).
 * Brews logged between midnight and 6:59am belong to the previous day's Night shift.
 */
function getShiftIdentifier(date) {
    const d = new Date(date);
    const hour = d.getHours();
    const shift = calculateShift(d);

    // Past-midnight Night shift (0:00-6:59): roll back to previous day
    if (shift === 'Night' && hour < 7) {
        d.setDate(d.getDate() - 1);
    }

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

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
 * Get the start and end timestamps for a given shift identifier.
 * shiftId format: "YYYY-MM-DD-SHIFT"
 */
function getShiftBoundaries(shiftId) {
    const parts = shiftId.split('-');
    const shift = parts[3];
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const day = parseInt(parts[2]);

    if (shift === 'AM') {
        return {
            start: new Date(year, month, day, 7, 0, 0),
            end:   new Date(year, month, day, 15, 0, 0)
        };
    } else if (shift === 'PM') {
        return {
            start: new Date(year, month, day, 15, 0, 0),
            end:   new Date(year, month, day, 23, 0, 0)
        };
    } else {
        // Night: 23:00 on the date through 07:00 the next day
        return {
            start: new Date(year, month, day, 23, 0, 0),
            end:   new Date(year, month, day + 1, 7, 0, 0)
        };
    }
}

/**
 * Check if a brew already exists for this shift and bean type (at current location).
 * Queries Firestore directly to avoid stale-cache false negatives.
 */
async function checkDuplicateBrew(beanType, shiftId) {
    const { start, end } = getShiftBoundaries(shiftId);
    const q = query(
        collection(db, COLLECTION_NAME),
        where('location', '==', selectedLocation),
        where('beanType', '==', beanType),
        where('timestamp', '>=', Timestamp.fromDate(start)),
        where('timestamp', '<',  Timestamp.fromDate(end))
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    // Return the first match in the same shape the rest of the code expects
    const d = snapshot.docs[0];
    const data = d.data();
    const timestamp = data.timestamp.toDate();
    return {
        id: d.id,
        location: data.location,
        extractionWeight: data.extractionWeight,
        extractionTime: data.extractionTime,
        grindTime: data.grindTime,
        beanType: data.beanType,
        timestamp: timestamp.toISOString(),
        shift: data.shift || calculateShift(timestamp),
        shiftId: data.shiftId || getShiftIdentifier(timestamp)
    };
}

/**
 * Save brew to Firestore
 */
async function saveBrew(brewData) {
    await addDoc(collection(db, COLLECTION_NAME), brewData);
    console.log('✅ Brew saved to Firestore');
}

/**
 * Update existing brew (atomic delete + create via batch)
 */
async function updateBrew(brewId, brewData) {
    const batch = writeBatch(db);
    const oldRef = doc(db, COLLECTION_NAME, brewId);
    const newRef = doc(collection(db, COLLECTION_NAME));
    batch.delete(oldRef);
    batch.set(newRef, brewData);
    await batch.commit();
    console.log('✅ Brew updated in Firestore (atomic)');
}

/**
 * Build a Firestore query based on current view state.
 * Applies limit(200) for today/week filters to save reads; no limit for 'all'.
 */
function buildQuery() {
    const useLimit = currentFilter !== 'all';

    if (isGlobalView) {
        return useLimit
            ? query(collection(db, COLLECTION_NAME), orderBy('timestamp', 'desc'), firestoreLimit(200))
            : query(collection(db, COLLECTION_NAME), orderBy('timestamp', 'desc'));
    } else {
        return useLimit
            ? query(collection(db, COLLECTION_NAME), where('location', '==', selectedLocation), orderBy('timestamp', 'desc'), firestoreLimit(200))
            : query(collection(db, COLLECTION_NAME), where('location', '==', selectedLocation), orderBy('timestamp', 'desc'));
    }
}

/**
 * Parse a Firestore snapshot into a brew array.
 */
function parseSnapshot(querySnapshot) {
    const brews = [];
    querySnapshot.forEach((d) => {
        const data = d.data();
        const timestamp = data.timestamp.toDate();
        brews.push({
            id: d.id,
            location: data.location,
            extractionWeight: data.extractionWeight,
            extractionTime: data.extractionTime,
            grindTime: data.grindTime,
            beanType: data.beanType,
            timestamp: timestamp.toISOString(),
            // Use the shift and shiftId written at brew time (in the café's
            // local timezone) so viewers in other timezones see the correct
            // shift.  Fall back to recalculating for legacy documents that
            // pre-date these fields.
            shift: data.shift || calculateShift(timestamp),
            shiftId: data.shiftId || getShiftIdentifier(timestamp)
        });
    });
    return brews;
}

/**
 * Re-render the UI from the current allBrewsCache.
 */
function renderFromCache() {
    const filteredBrews = filterBrews(allBrewsCache, currentFilter);
    const streak = calculateStreak(allBrewsCache);
    renderTable(filteredBrews);
    updateStats(allBrewsCache.length, filteredBrews.length, streak);
    updateShiftStatus();
}

/**
 * Subscribe to real-time Firestore updates.
 * Unsubscribes any previous listener, then starts a new one.
 * Each snapshot updates allBrewsCache and re-renders the UI.
 */
function subscribeToBrew() {
    // Unsubscribe previous listener
    if (activeUnsubscribe) {
        activeUnsubscribe();
        activeUnsubscribe = null;
    }

    showLoading();
    let isFirstSnapshot = true;

    const q = buildQuery();
    console.log(`🔄 Subscribing to brews for ${isGlobalView ? 'ALL LOCATIONS' : selectedLocation}`);

    activeUnsubscribe = onSnapshot(q, (querySnapshot) => {
        allBrewsCache = parseSnapshot(querySnapshot);
        console.log(`📊 Snapshot: ${allBrewsCache.length} brews`);

        if (isFirstSnapshot) {
            hideLoading();
            isFirstSnapshot = false;
        }

        renderFromCache();

        // Resolve any pending snapshot promise (for post-write flow)
        if (snapshotPromise) {
            snapshotPromise.resolve();
            snapshotPromise = null;
        }
    }, (error) => {
        console.error('❌ Snapshot error:', error);
        hideLoading();
        showError('Failed to load brews. Check your connection.');
    });
}

/**
 * Returns a promise that resolves when the next onSnapshot callback fires.
 * Used by handleSubmit to wait for a write to be reflected in allBrewsCache.
 */
function waitForSnapshot() {
    return new Promise(resolve => {
        snapshotPromise = { resolve };
    });
}

/**
 * Group brews by shift
 */
function groupBrewsByShift(brews) {
    const groups = {};

    brews.forEach(brew => {
        const shiftId = brew.shiftId;
        if (!groups[shiftId]) {
            groups[shiftId] = [];
        }
        groups[shiftId].push(brew);
    });

    return groups;
}

/**
 * Check if two shifts are consecutive (no gap between them)
 * With night-shift date rollback, identifiers for a single day are:
 *   day N-AM (07:00-14:59), day N-PM (15:00-22:59), day N-Night (23:00-06:59 next day)
 * Same-day progression: AM → PM → Night
 * Cross-day progression: Night (day N) → AM (day N+1)
 */
function isConsecutiveShift(olderShiftId, newerShiftId) {
    const [olderYear, olderMonth, olderDay, olderShift] = olderShiftId.split('-');
    const [newerYear, newerMonth, newerDay, newerShift] = newerShiftId.split('-');

    const olderDate = new Date(olderYear, parseInt(olderMonth) - 1, parseInt(olderDay));
    const newerDate = new Date(newerYear, parseInt(newerMonth) - 1, parseInt(newerDay));

    // Same day shifts: AM → PM → Night
    if (olderDate.getTime() === newerDate.getTime()) {
        if (olderShift === 'AM' && newerShift === 'PM') return true;
        if (olderShift === 'PM' && newerShift === 'Night') return true;
        if (olderShift === 'AM' && newerShift === 'Night') return true; // PM was skipped
        return false;
    }

    // Cross-day: must be exactly 1 day apart
    const dayDiff = Math.floor((newerDate - olderDate) / (1000 * 60 * 60 * 24));
    if (dayDiff !== 1) return false;

    // Night (day N, ends 06:59 of day N+1) → AM (day N+1, starts 07:00)
    if (olderShift === 'Night' && newerShift === 'AM') return true;

    return false;
}

/**
 * Calculate streak (consecutive complete shifts)
 * A complete shift = both House AND Decaf logged
 */
function calculateStreak(allBrews) {
    console.log(`📊 Calculating streak from ${allBrews.length} brews`);
    
    if (allBrews.length === 0) {
        console.log('❌ No brews logged - streak = 0');
        return 0;
    }
    
    const groups = groupBrewsByShift(allBrews);
    
    // Sort shift IDs by actual timestamp (most recent first)
    const sortedShiftIds = Object.keys(groups).sort((a, b) => {
        // Get the latest timestamp from each shift
        const latestA = Math.max(...groups[a].map(brew => new Date(brew.timestamp).getTime()));
        const latestB = Math.max(...groups[b].map(brew => new Date(brew.timestamp).getTime()));
        return latestB - latestA; // Descending order (most recent first)
    });
    
    console.log(`📅 Found ${sortedShiftIds.length} shifts:`, sortedShiftIds.slice(0, 5)); // Show first 5
    
    // Get the current shift ID based on current time
    const currentShiftId = getShiftIdentifier(new Date());
    const mostRecentLoggedShiftId = sortedShiftIds[0];

    console.log(`🕐 Current shift: ${currentShiftId}`);
    console.log(`📝 Most recent logged shift: ${mostRecentLoggedShiftId}`);

    // If the most recent logged shift is not the current shift, check whether
    // the current shift is the immediate next one (grace period). If there's a
    // gap of more than one shift the streak is broken.
    if (currentShiftId !== mostRecentLoggedShiftId) {
        if (!isConsecutiveShift(mostRecentLoggedShiftId, currentShiftId)) {
            console.log('❌ Gap between last logged shift and current shift - streak broken');
            return 0;
        }
        console.log('⏳ Current shift has no brews yet — grace period (consecutive with last logged shift)');
    }

    let streak = 0;
    let previousShiftId = null;

    for (const shiftId of sortedShiftIds) {
        const brews = groups[shiftId];
        const hasHouse = brews.some(b => b.beanType === 'House');
        const hasDecaf = brews.some(b => b.beanType === 'Decaf');

        console.log(`  ${shiftId}: House=${hasHouse}, Decaf=${hasDecaf}`);

        // The current (in-progress) shift gets a grace period — skip over it
        // if it's incomplete so we don't break the streak prematurely
        if (shiftId === currentShiftId && (!hasHouse || !hasDecaf)) {
            console.log(`    ⏳ Current shift incomplete — grace period, skipping`);
            previousShiftId = shiftId;
            continue;
        }

        // Check if this shift is complete (both beans logged)
        if (!hasHouse || !hasDecaf) {
            console.log(`    ❌ Incomplete shift - streak ends at ${streak}`);
            break;
        }

        // Check if there's a gap between this shift and the previous one
        if (previousShiftId !== null && !isConsecutiveShift(shiftId, previousShiftId)) {
            console.log(`    ❌ Gap detected between ${shiftId} and ${previousShiftId} - streak ends at ${streak}`);
            break;
        }

        // This shift is complete and consecutive
        streak++;
        previousShiftId = shiftId;
        console.log(`    ✅ Complete shift! Streak: ${streak}`);
    }
    
    console.log(`🔥 Final streak: ${streak}`);
    return streak;
}

/**
 * Check if shift was just completed (both beans now logged)
 */
function wasShiftJustCompleted(shiftId, newBeanType) {
    const shiftBrews = allBrewsCache.filter(brew =>
        brew.shiftId === shiftId
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
                    <p>No brews logged yet.</p>
                </td>
            </tr>
        `;
        return;
    }
    
    // Group brews by shift
    const groups = groupBrewsByShift(brews);
    
    // Sort shifts by the timestamp of their latest brew (most recent shift first)
    const sortedShiftIds = Object.keys(groups).sort((a, b) => {
        // Get the latest timestamp from each shift
        const latestA = Math.max(...groups[a].map(brew => new Date(brew.timestamp).getTime()));
        const latestB = Math.max(...groups[b].map(brew => new Date(brew.timestamp).getTime()));
        return latestB - latestA; // Descending order (most recent first)
    });
    
    // Render each group
    sortedShiftIds.forEach(shiftId => {
        // Add shift group header
        const headerRow = document.createElement('tr');
        headerRow.className = 'shift-group-header';
        headerRow.innerHTML = `
            <td colspan="${colspan}">${getShiftDisplayDate(shiftId)}</td>
        `;
        tableBody.appendChild(headerRow);
        
        // Add brews in this shift (sort by timestamp DESC - newest first)
        const shiftBrews = groups[shiftId].sort((a, b) => {
            // Sort by timestamp descending (newest first)
            const timeA = new Date(a.timestamp).getTime();
            const timeB = new Date(b.timestamp).getTime();
            return timeB - timeA; // Descending order
        });
        
        shiftBrews.forEach(brew => {
            const row = document.createElement('tr');
            
            // Add class for mobile card layout with location
            if (isGlobalView) {
                row.classList.add('has-location');
                row.setAttribute('data-location', brew.location);
            }
            
            // Get abbreviation from location name (for global view)
            const abbr = isGlobalView ? (
                {
                    'Shoreditch': 'LSD',
                    'Tower': 'LTL',
                    'Bankside': 'LBS',
                    'Victoria': 'LVS',
                    'Olympia': 'LOL'
                }[brew.location] || brew.location.substring(0, 3).toUpperCase()
            ) : null;
            
            // MOBILE: Location marker cell FIRST (for mobile 3-column grid)
            if (isGlobalView) {
                const markerCell = document.createElement('td');
                markerCell.className = 'location-marker';
                markerCell.setAttribute('data-location', brew.location);
                markerCell.textContent = abbr;
                row.appendChild(markerCell);
            }
            
            // 1. Timestamp cell
            const timeCell = document.createElement('td');
            timeCell.className = 'brew-time';
            timeCell.textContent = formatTimestamp(brew.timestamp);
            row.appendChild(timeCell);
            
            // Content cell - wraps badges and details
            const contentCell = document.createElement('td');
            contentCell.className = 'brew-content';
            
            // 2-3. Badges container (shift + bean)
            const badgesDiv = document.createElement('div');
            badgesDiv.className = 'brew-badges';
            badgesDiv.innerHTML = `
                <span class="shift-badge shift-${brew.shift}">${brew.shift}</span>
                <span class="bean-badge bean-${brew.beanType}">${brew.beanType}</span>
            `;
            contentCell.appendChild(badgesDiv);
            
            // 4. Location (desktop only - as a table cell in the middle)
            if (isGlobalView) {
                const locationCell = document.createElement('div');
                locationCell.className = 'brew-location-desktop';
                locationCell.textContent = abbr; // Reuse abbreviation
                contentCell.appendChild(locationCell);
            }
            
            // 5-6-7. Details container (weight, time, grind)
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
    statShowingLabel.textContent = FILTER_LABELS[currentFilter] || 'Showing';

    // Only show streak in location-specific view
    if (isGlobalView) {
        statStreak.textContent = '—';
        console.log('📊 Stats: Global view - streak hidden');
    } else {
        statStreak.textContent = streak > 0 ? `🔥 ${streak}` : '—';
        console.log(`📊 Stats: Total=${totalBrews}, Showing=${filteredBrews}, Streak=${streak}`);
    }
}

/**
 * Update shift status indicator showing which beans are logged for the current shift
 */
function updateShiftStatus() {
    if (!shiftStatusEl) return;

    // Hide in global view
    if (isGlobalView) {
        shiftStatusEl.innerHTML = '';
        return;
    }

    const now = new Date();
    const currentShiftId = getShiftIdentifier(now);
    const currentShift = calculateShift(now);

    const shiftBrews = allBrewsCache.filter(brew =>
        brew.location === selectedLocation &&
        brew.shiftId === currentShiftId
    );

    const hasHouse = shiftBrews.some(b => b.beanType === 'House');
    const hasDecaf = shiftBrews.some(b => b.beanType === 'Decaf');

    shiftStatusEl.innerHTML = `
        <span class="status-bean ${hasHouse ? 'logged' : 'missing'}">${hasHouse ? '✅' : '◻️'} House</span>
        <span class="status-bean ${hasDecaf ? 'logged' : 'missing'}">${hasDecaf ? '✅' : '◻️'} Decaf</span>
    `;
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
            
            // Resubscribe with new location
            subscribeToBrew();
        });
    });
}

/**
 * Setup filter tab event listeners
 */
function setupFilterTabs() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            const previousFilter = currentFilter;

            // Update active state
            filterTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update current filter
            currentFilter = tab.dataset.filter;

            // Resubscribe if switching to/from 'all' (query limit changes)
            const limitChanged = (previousFilter === 'all') !== (currentFilter === 'all');
            if (limitChanged) {
                subscribeToBrew();
            } else {
                // Re-render from live cache (no re-subscribe needed)
                renderFromCache();
            }
        });
    });
}

/**
 * Handle form submission
 */
async function handleSubmit(e) {
    e.preventDefault();
    
    // Show loading state
    submitBtn.disabled = true;
    btnText.classList.add('hidden');
    btnSpinner.classList.remove('hidden');


    // Get form values
    const weight = parseFloat(document.getElementById('weight').value);
    const time = parseFloat(document.getElementById('time').value);
    const grind = parseFloat(document.getElementById('grind').value);
    
    // Check for invalid/missing values
    if (isNaN(weight) || isNaN(time) || isNaN(grind)) {
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError('Please fill in all fields with valid numbers');
        return;
    }
    
    // Validate ranges
    const timeConfig = BEAN_CONFIGS[selectedBeanType];
    
    // Weight validation (18.5 - 19.5g)
    if (weight < 18.5 || weight > 19.5) {
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError('Weight must be between 18.5-19.5g');
        weightHint.classList.remove('hidden');
        weightInput.focus();
        return;
    }
    
    // Time validation (depends on bean type)
    if (time < timeConfig.minTime || time > timeConfig.maxTime) {
        submitBtn.disabled = false;
        const coarseFine = value > config.maxTime ? "coarser" : "finer";
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError(`Time must be between ${timeConfig.minTime}-${timeConfig.maxTime}s for ${selectedBeanType}. Try adjusting the grinder wheel to make it ${coarseFine}.`);
        timeHint.classList.remove('hidden');
        timeInput.focus();
        return;
    }
    
    // Grind validation (3 - 15s)
    if (grind < 3 || grind > 15) {
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError('Grind time must be between 3-15s');
        grindHint.classList.remove('hidden');
        grindInput.focus();
        return;
    }
    
    console.log('✅ All values within valid ranges');
    console.log(`  Weight: ${weight}g (18.5-19.5)`);
    console.log(`  Time: ${time}s (${timeConfig.minTime}-${timeConfig.maxTime})`);
    console.log(`  Grind: ${grind}s (3-15)`);
    
    // Hide all validation hints since values are valid
    weightHint.classList.add('hidden');
    timeHint.classList.add('hidden');
    grindHint.classList.add('hidden');
    
    // Create brew data object
    const now = new Date();
    const shiftId = getShiftIdentifier(now);
    
    // Check for duplicate
    let existingBrew = null; // Declare outside try-catch so it's accessible later
    try {
        existingBrew = await checkDuplicateBrew(selectedBeanType, shiftId);
        
        if (existingBrew) {
            console.log('⚠️ Duplicate brew detected');
            const currentShift = calculateShift(now);
            const confirmOverwrite = await showModal(
                `You've already logged a <strong>${selectedBeanType}</strong> brew for the <strong>${currentShift} shift</strong>.`
            );
            
            console.log('User choice:', confirmOverwrite ? 'Replace' : 'Cancel');
            
            if (!confirmOverwrite) {
                // User cancelled - reset button state
                submitBtn.disabled = false;
                btnText.classList.remove('hidden');
                btnSpinner.classList.add('hidden');
                return;
            }
        }
    } catch (error) {
        console.error('❌ Error checking duplicate:', error);
        // Reset button state on error
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError('An error occurred. Please try again.');
        return;
    }
    
    const brewData = {
        location: selectedLocation,
        extractionWeight: weight,
        extractionTime: time,
        grindTime: grind,
        timestamp: Timestamp.fromDate(now),
        shift: calculateShift(now),
        shiftId: shiftId,
        beanType: selectedBeanType
    };
    
    console.log('💾 Saving brew data:', brewData);
    
    // Check if shift was just completed (before write, using current cache)
    const shiftCompleted = wasShiftJustCompleted(shiftId, selectedBeanType);

    // Save or update — wait for onSnapshot to reflect the write
    const nextSnapshot = waitForSnapshot();
    try {
        if (existingBrew) {
            console.log('🔄 Updating existing brew...');
            await updateBrew(existingBrew.id, brewData);
        } else {
            console.log('➕ Creating new brew...');
            await saveBrew(brewData);
        }

        console.log('✅ Brew saved, waiting for snapshot...');
        await nextSnapshot; // onSnapshot fires, updates allBrewsCache + re-renders
        console.log('✅ Snapshot received');
    } catch (error) {
        console.error('❌ Error saving brew:', error);
        snapshotPromise = null; // Clean up pending promise
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
        showError('Failed to save brew. Please try again.');
        return;
    }

    // Calculate new streak (allBrewsCache is now updated by onSnapshot)
    const newStreak = calculateStreak(allBrewsCache);
    
    // Reset form
    form.reset();
    
    // Focus back on first input
    document.getElementById('weight').focus();

    // Hide loading state  
    submitBtn.disabled = false;
    btnText.classList.remove('hidden');
    btnSpinner.classList.add('hidden');

    triggerHaptic(); // Add haptic feedback
    
    console.log('🎉 Submit complete!');
    
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
document.querySelectorAll('input[type="number"], input[type="text"][inputmode="decimal"]').forEach(input => {
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            form.requestSubmit();
        }
    });
});

// Fix iOS decimal separator issue (comma vs dot)
// Some iOS keyboards show comma instead of dot based on locale
document.querySelectorAll('input[type="number"], input[type="text"][inputmode="decimal"]').forEach(input => {
    input.addEventListener('input', (e) => {
        // Replace comma with dot for decimal separator
        const value = e.target.value;
        if (value.includes(',')) {
            e.target.value = value.replace(/,/g, '.');
        }
    });
    
    // Also handle paste events
    input.addEventListener('paste', (e) => {
        setTimeout(() => {
            const value = e.target.value;
            if (value.includes(',')) {
                e.target.value = value.replace(/,/g, '.');
            }
        }, 0);
    });
});
