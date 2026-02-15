// Import Firebase SDK from CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { 
    getFirestore, 
    collection, 
    addDoc, 
    query, 
    orderBy, 
    getDocs,
    Timestamp 
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// Import your Firebase config
import { firebaseConfig } from './firebase-config.js';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Constants
const COLLECTION_NAME = 'brews';

// State
let currentFilter = 'today';
let allBrewsCache = []; // Cache to avoid re-fetching

// DOM Elements
const form = document.getElementById('brew-log');
const tableBody = document.getElementById('brew-table-body');
const toast = document.getElementById('toast');
const filterTabs = document.querySelectorAll('.filter-tab');
const statTotal = document.getElementById('stat-total');
const statShowing = document.getElementById('stat-showing');

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    loadAndRenderBrews();
    form.addEventListener('submit', handleSubmit);
    setupFilterTabs();
});

/**
 * Calculate shift based on hour of day
 * AM: 7:00 - 14:59
 * PM: 15:00 - 22:59
 * Night: 23:00 - 6:59
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
 * Format timestamp for display
 * Shows "Today HH:MM" or "Yesterday HH:MM" or "DD/MM/YYYY HH:MM"
 */
function formatTimestamp(date) {
    const now = new Date();
    const brewDate = new Date(date);
    
    const isToday = brewDate.toDateString() === now.toDateString();
    
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = brewDate.toDateString() === yesterday.toDateString();
    
    const timeString = brewDate.toLocaleTimeString('en-GB', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    if (isToday) {
        return `Today ${timeString}`;
    } else if (isYesterday) {
        return `Yesterday ${timeString}`;
    } else {
        const dateString = brewDate.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
        return `${dateString} ${timeString}`;
    }
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
 * Load all brews from Firestore
 */
async function loadBrews() {
    try {
        const q = query(
            collection(db, COLLECTION_NAME), 
            orderBy('timestamp', 'desc')
        );
        
        const querySnapshot = await getDocs(q);
        const brews = [];
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            brews.push({
                id: doc.id,
                ...data,
                // Convert Firestore Timestamp to JavaScript Date ISO string
                timestamp: data.timestamp.toDate().toISOString()
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
 * Render brews table
 */
function renderTable(brews) {
    // Clear existing rows
    tableBody.innerHTML = '';
    
    if (brews.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-state">
                    <p>No brews logged yet. Start logging to see your history!</p>
                </td>
            </tr>
        `;
        return;
    }
    
    // Create rows for each brew
    brews.forEach(brew => {
        const row = document.createElement('tr');
        
        row.innerHTML = `
            <td>${formatTimestamp(brew.timestamp)}</td>
            <td><span class="shift-badge shift-${brew.shift}">${brew.shift}</span></td>
            <td>${brew.extractionWeight}</td>
            <td>${brew.extractionTime}</td>
            <td>${brew.grindTime}</td>
        `;
        
        tableBody.appendChild(row);
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
function updateStats(totalBrews, filteredBrews) {
    statTotal.textContent = totalBrews;
    statShowing.textContent = filteredBrews;
}

/**
 * Load and render brews from Firestore
 */
async function loadAndRenderBrews() {
    allBrewsCache = await loadBrews();
    const filteredBrews = filterBrews(allBrewsCache, currentFilter);
    renderTable(filteredBrews);
    updateStats(allBrewsCache.length, filteredBrews.length);
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
            renderTable(filteredBrews);
            updateStats(allBrewsCache.length, filteredBrews.length);
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
    const brewData = {
        extractionWeight: weight,
        extractionTime: time,
        grindTime: grind,
        timestamp: Timestamp.fromDate(now), // Firestore Timestamp
        shift: calculateShift(now)
    };
    
    // Save to Firestore
    await saveBrew(brewData);
    
    // Reload data from Firestore
    await loadAndRenderBrews();
    
    // Reset form
    form.reset();
    
    // Focus back on first input
    document.getElementById('weight').focus();
    
    // Show success toast
    showToast();
}

/**
 * Show success toast notification
 */
function showToast() {
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
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
