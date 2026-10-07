'use strict';

const createStarterData = () => ({
  transactions: [],
  categories: DEFAULT_CATS.map(([name, icon]) => ({ name, icon })),
  budgets: [],
  goals: [],
  debts: [],
  wishlist: [],
  currency: 'KSh',
  userName: ''
});

const storedSpendData = JSON.parse(localStorage.getItem('spendwise-data') || 'null');
localStorage.removeItem('spendwise-cloud-session');
localStorage.removeItem('spendwise-cloud-config');
data = { ...createStarterData(), ...(storedSpendData || {}) };
data.transactions = Array.isArray(data.transactions) ? data.transactions : [];
data.categories = Array.isArray(data.categories) ? data.categories : createStarterData().categories;
data.budgets = Array.isArray(data.budgets) ? data.budgets : [];
data.goals = Array.isArray(data.goals) ? data.goals : [];
data.debts = Array.isArray(data.debts) ? data.debts : [];
data.wishlist = Array.isArray(data.wishlist) ? data.wishlist : [];
data.goals.forEach(goal => {
  if (!goal.id) goal.id = crypto.randomUUID();
});
data.deleted = { transactions: [], categories: [], budgets: [], goals: [], debts: [], wishlist: [], ...(data.deleted || {}) };
Object.keys(data.deleted).forEach(key => {
  data.deleted[key] = Array.isArray(data.deleted[key]) ? data.deleted[key] : [];
});

let cloudSession = null;
let syncTimer;
let syncInFlight;
let syncAgain = false;

function setStatus(message, error = false) {
  const line = document.getElementById('cloudMessage');
  const status = document.getElementById('topStatus');
  const welcomeMessage = document.getElementById('welcomeMessage');
  if (line) {
    line.textContent = message;
    line.style.color = error ? '#c4455f' : '';
  }
  if (status) {
    const color = error ? '#df5670' : cloudSession ? '#218c68' : '#b09bcf';
    status.innerHTML = `<i style="background:${color}"></i>${esc(message)}`;
  }
  if (welcomeMessage && document.body.classList.contains('entry-mode')) welcomeMessage.textContent = message;
}

function updateAccountControls() {
  const signedIn = Boolean(cloudSession?.user?.id);
  document.getElementById('cloudSession').style.display = signedIn ? 'block' : 'none';
  document.getElementById('cloudAuthForm').style.display = signedIn ? 'none' : 'grid';
  document.getElementById('cloudAccount').textContent = signedIn
    ? `Signed in as ${cloudSession.user.email || 'your account'}`
    : '';
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the SpendWise account server. Start it with `npm start`, then open the app at the server URL (usually http://localhost:3000).');
    }
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  const result = response.status === 204
    ? null
    : contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : null;
  if (!response.ok) {
    if (response.status === 404 || !contentType.includes('application/json')) {
      throw new Error(`The SpendWise account API is unavailable (HTTP ${response.status}). Start the Node server with \`npm start\` and open the app from that server, not a static preview.`);
    }
    throw new Error(result?.error || `The SpendWise server returned HTTP ${response.status} without an error message.`);
  }
  if (response.status !== 204 && !contentType.includes('application/json')) {
    throw new Error('The SpendWise server returned an unexpected response. Restart it with `npm start` and open the app from that server URL.');
  }
  return result;
}

function persistCurrentData() {
  localStorage.setItem('spendwise-data', JSON.stringify(data));
}

function mergeItems(first = [], second = [], key = 'id') {
  const items = new Map();
  [...first, ...second].forEach(item => {
    const id = item?.[key];
    if (id !== undefined && id !== null) {
      const normalized = String(id);
      items.set(normalized, { ...(items.get(normalized) || {}), ...item });
    }
  });
  return [...items.values()];
}

function normalizeWishlistItem(item) {
  if (!item || typeof item !== 'object') return null;
  const allocatedBudget = Number(item.allocatedBudget);
  const estimatedCost = Number(item.estimatedCost);
  const amountSaved = Number(item.amountSaved);
  const priority = wishlistPriorities?.includes(item.priority) ? item.priority : 'Medium';
  let status = wishlistStatuses?.includes(item.status) ? item.status : 'Planning';
  if (!String(item.name || '').trim() || !Number.isFinite(allocatedBudget) || allocatedBudget <= 0 ||
      !Number.isFinite(estimatedCost) || estimatedCost < 0 ||
      !Number.isFinite(amountSaved) || amountSaved < 0) return null;
  if (status === 'Ready to Buy' && amountSaved < allocatedBudget) status = amountSaved > 0 ? 'Saving' : 'Planning';
  if (amountSaved >= allocatedBudget && !['Purchased', 'Cancelled'].includes(status)) status = 'Ready to Buy';
  return {
    ...item,
    id: String(item.id || crypto.randomUUID()),
    name: String(item.name).trim(),
    description: String(item.description || ''),
    category: Object.hasOwn(wishlistCategories || {}, item.category) ? item.category : 'Other',
    estimatedCost,
    allocatedBudget,
    amountSaved: Math.min(amountSaved, allocatedBudget),
    priority,
    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(item.targetDate || '') ? item.targetDate : '',
    status,
    purchaseLink: String(item.purchaseLink || ''),
    notes: String(item.notes || ''),
    createdAt: String(item.createdAt || new Date().toISOString())
  };
}

function mergeSpendData(local, remote = {}) {
  const deleted = {};
  for (const type of ['transactions', 'categories', 'budgets', 'goals', 'debts', 'wishlist']) {
    deleted[type] = [...new Set([
      ...(local.deleted?.[type] || []),
      ...(remote.deleted?.[type] || [])
    ].map(String))];
  }

  return {
    ...createStarterData(),
    ...remote,
    ...local,
    userName: local.userName || remote.userName || '',
    transactions: mergeItems(remote.transactions, local.transactions)
      .filter(item => !deleted.transactions.includes(String(item.id))),
    categories: mergeItems(remote.categories, local.categories, 'name')
      .filter(item => !deleted.categories.includes(String(item.name))),
    budgets: mergeItems(remote.budgets, local.budgets, 'category')
      .filter(item => !deleted.budgets.includes(String(item.category))),
    goals: mergeItems(remote.goals, local.goals)
      .filter(item => !deleted.goals.includes(String(item.id))),
    debts: mergeItems(remote.debts, local.debts)
      .filter(item => !deleted.debts.includes(String(item.id))),
    wishlist: mergeItems(remote.wishlist, local.wishlist)
      .map(normalizeWishlistItem).filter(item => item && !deleted.wishlist.includes(String(item.id))),
    deleted
  };
}

async function syncNow() {
  if (!cloudSession?.user?.id) {
    setStatus('Saved on this device · sign in to sync across devices.');
    return;
  }
  if (syncInFlight) {
    syncAgain = true;
    return syncInFlight;
  }

  syncInFlight = (async () => {
    setStatus('Syncing your data…');
    const userId = cloudSession.user.id;
    const activeUser = localStorage.getItem('spendwise-active-user');
    if (activeUser && activeUser !== userId) {
      localStorage.setItem(`spendwise-data-${activeUser}`, JSON.stringify(data));
      data = JSON.parse(localStorage.getItem(`spendwise-data-${userId}`) || 'null') || createStarterData();
      data.deleted = { transactions: [], categories: [], budgets: [], goals: [], debts: [], wishlist: [], ...(data.deleted || {}) };
    }

    const remote = await apiRequest('/api/data');
    data = mergeSpendData(data, remote?.data || {});
    persistCurrentData();
    await apiRequest('/api/data', {
      method: 'PUT',
      body: JSON.stringify({ data })
    });

    localStorage.setItem('spendwise-active-user', userId);
    localStorage.setItem(`spendwise-data-${userId}`, JSON.stringify(data));
    render();
    setStatus(`Synced · ${cloudSession.user.email || 'your account'}`);
  })();

  try {
    await syncInFlight;
  } finally {
    syncInFlight = null;
    if (syncAgain) {
      syncAgain = false;
      scheduleCloudSync();
    }
  }
}

function scheduleCloudSync() {
  if (!cloudSession?.user?.id) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow().catch(error => {
      console.error('SpendWise sync failed:', error);
      setStatus(error.message, true);
    });
  }, 700);
}

const categoryIcons = {
  food: 'utensils',
  transport: 'car',
  housing: 'home',
  utilities: 'bolt',
  entertainment: 'ticket',
  health: 'heart',
  education: 'book',
  other: 'shapes'
};

const plannerScreen = document.createElement('section');
plannerScreen.id = 'planner';
plannerScreen.className = 'screen planner';
plannerScreen.innerHTML = `
  <header class="planner-hero">
    <div class="planner-kicker">${svgIcon('planner')} Wishlist &amp; Purchase Planner</div>
    <h2>Plan it. Budget it. Buy it wisely.</h2>
    <p>Know what you want. Know what it costs. Stay intentional with your money.</p>
    <div class="planner-hero-foot">
      <span class="planner-microcopy">Small savings. Bigger purchases. Your wishlist shouldn't become your debt list.</span>
      <button class="primary planner-add" type="button" data-planner-add>+ Add Wishlist Item</button>
    </div>
  </header>
  <div class="planner-summary" aria-label="Wishlist totals">
    <article class="planner-stat"><div class="planner-stat-top"><span>Total Planned</span><span class="planner-icon">${svgIcon('budgets')}</span></div><strong id="plannerTotal">KSh 0</strong><small>Across active planned purchases</small></article>
    <article class="planner-stat saved"><div class="planner-stat-top"><span>Saved So Far</span><span class="planner-icon">${svgIcon('goals')}</span></div><strong id="plannerSaved">KSh 0</strong><small>Set aside for your plans</small></article>
    <article class="planner-stat remaining"><div class="planner-stat-top"><span>Remaining</span><span class="planner-icon">${svgIcon('reports')}</span></div><strong id="plannerRemaining">KSh 0</strong><small>Still needed for active items</small></article>
    <article class="planner-stat"><div class="planner-stat-top"><span>Items</span><span class="planner-icon">${svgIcon('categories')}</span></div><strong id="plannerCount">0</strong><small>Active purchase plans</small></article>
  </div>
  <article class="planner-progress-card">
    <div class="planner-progress-head"><strong>Overall Purchase Progress</strong><span><b id="plannerSavedLabel">KSh 0</b> saved of <span id="plannerPlannedLabel">KSh 0</span></span></div>
    <div class="planner-track" role="progressbar" aria-label="Overall purchase progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="plannerOverallProgress"></i></div>
  </article>
  <div class="planner-toolbar">
    <label class="planner-search">${svgIcon('search')}<input id="plannerSearch" type="search" placeholder="Search your wishlist..." aria-label="Search your wishlist"></label>
    <select id="plannerStatusFilter" class="planner-select" aria-label="Filter by status"><option value="all">All statuses</option><option value="Planning">Planning</option><option value="Saving">Saving</option><option value="Ready to Buy">Ready to Buy</option><option value="Purchased">Purchased</option><option value="Cancelled">Cancelled</option></select>
    <select id="plannerSort" class="planner-select" aria-label="Sort wishlist"><option value="recent">Recently added</option><option value="budget-high">Highest budget</option><option value="budget-low">Lowest budget</option><option value="date">Closest purchase date</option><option value="priority">Highest priority</option><option value="progress">Progress</option></select>
  </div>
  <div id="plannerPriorityFilters" class="planner-filters" role="group" aria-label="Filter by priority"></div>
  <div class="planner-results-head"><h3 id="plannerListTitle">Active purchase plans</h3><span id="plannerResultCount">0 items</span></div>
  <div id="plannerItems" class="wishlist-grid"></div>
  <section id="plannerPurchasedSection" class="planner-subsection" hidden><h3>${svgIcon('goals')} Purchased Items</h3><div id="plannerPurchased" class="wishlist-grid"></div></section>
  <section id="plannerInsights" class="planner-insights">
    <article class="planner-panel"><div class="planner-panel-head"><div><h3>Purchase Timeline</h3><p>Upcoming targets at a glance</p></div>${svgIcon('planner')}</div><div id="plannerTimeline" class="planner-timeline"></div></article>
    <article class="planner-panel"><div class="planner-panel-head"><div><h3>Purchase Plan</h3><p>Planned budgets by target month</p></div>${svgIcon('reports')}</div><div id="plannerMonthlyChart" class="planner-chart"></div></article>
  </section>
  <p class="planner-disclaimer">Planning estimates are based only on information saved in SpendWise. They are not financial advice.</p>`;
document.querySelector('.content').insertBefore(plannerScreen, document.getElementById('debts'));
const plannerTotal = plannerScreen.querySelector('#plannerTotal');
const plannerSaved = plannerScreen.querySelector('#plannerSaved');
const plannerRemaining = plannerScreen.querySelector('#plannerRemaining');
const plannerCount = plannerScreen.querySelector('#plannerCount');
const plannerSavedLabel = plannerScreen.querySelector('#plannerSavedLabel');
const plannerPlannedLabel = plannerScreen.querySelector('#plannerPlannedLabel');
const plannerOverallProgress = plannerScreen.querySelector('#plannerOverallProgress');
const plannerPriorityFilters = plannerScreen.querySelector('#plannerPriorityFilters');
const plannerResultCount = plannerScreen.querySelector('#plannerResultCount');
const plannerListTitle = plannerScreen.querySelector('#plannerListTitle');
const plannerSearch = plannerScreen.querySelector('#plannerSearch');
const plannerStatusFilter = plannerScreen.querySelector('#plannerStatusFilter');
const plannerSort = plannerScreen.querySelector('#plannerSort');
const plannerItems = plannerScreen.querySelector('#plannerItems');
const plannerPurchasedSection = plannerScreen.querySelector('#plannerPurchasedSection');
const plannerPurchased = plannerScreen.querySelector('#plannerPurchased');
const plannerTimeline = plannerScreen.querySelector('#plannerTimeline');
const plannerMonthlyChart = plannerScreen.querySelector('#plannerMonthlyChart');

const debtsScreen = document.createElement('section');
debtsScreen.id = 'debts';
debtsScreen.className = 'screen';
debtsScreen.innerHTML = `<div class="screen-heading"><h2>People & debts</h2><p>Keep track of what you owe and what others owe you.</p></div><div id="debtSummary" class="debt-summary"></div><div class="report-actions"><button class="primary" type="button" id="addDebtButton">+ Add a debt</button></div><div class="card debt-section"><h3>They owe me</h3><div id="owedToMeList" class="list"></div></div><div class="card debt-section"><h3>I owe them</h3><div id="iOweList" class="list"></div></div><div class="card debt-section"><h3>Settled</h3><div id="settledDebtList" class="list"></div></div>`;
document.querySelector('.content').insertBefore(debtsScreen, document.getElementById('reports'));
const pdfButton = document.createElement('button');
pdfButton.type = 'button';
pdfButton.className = 'ghost';
pdfButton.id = 'downloadReportPdf';
pdfButton.textContent = 'Download PDF';
const reportActions = document.createElement('div');
reportActions.className = 'report-actions';
reportActions.append(pdfButton);
document.getElementById('reports').prepend(reportActions);
pdfButton.addEventListener('click', downloadReportPdf);
document.getElementById('addDebtButton').addEventListener('click', () => openDebt());

function decorateCategoryIcons() {
  const categoryIcon = name => categoryIcons[String(name || '').toLowerCase()] || 'shapes';
  document.querySelectorAll('#categorySummary .cat-row, #reportCats .cat-row').forEach(row => {
    const icon = row.querySelector('span:first-child');
    if (icon) icon.innerHTML = svgIcon(categoryIcon(row.querySelector('strong')?.textContent));
  });
  document.querySelectorAll('#categoryPage .tx, #recent .tx, #allTx .tx').forEach(row => {
    const icon = row.querySelector('.avatar');
    const name = row.querySelector('.tx-main small')?.textContent?.split(' · ')[0];
    if (icon) icon.innerHTML = svgIcon(categoryIcon(name));
  });
  document.querySelectorAll('#budgetPage .cat-row>span:first-child').forEach(icon => {
    icon.innerHTML = svgIcon('budgets');
  });
}

const wishlistCategories = {
  Electronics: 'bolt',
  Clothing: 'shapes',
  Transport: 'car',
  Education: 'book',
  Home: 'home',
  Health: 'heart',
  Entertainment: 'ticket',
  Travel: 'car',
  Gifts: 'goals',
  Other: 'shapes'
};
const wishlistPriorities = ['Essential', 'High', 'Medium', 'Low', 'Just Want It'];
const wishlistStatuses = ['Planning', 'Saving', 'Ready to Buy', 'Purchased', 'Cancelled'];
data.wishlist = data.wishlist.map(normalizeWishlistItem).filter(Boolean);
let wishlistPriorityFilter = 'all';
const plannerDialogBack = document.createElement('div');
plannerDialogBack.className = 'planner-modal-back';
plannerDialogBack.innerHTML = '<div class="planner-modal" role="dialog" aria-modal="true" aria-labelledby="plannerDialogTitle"></div>';
document.body.append(plannerDialogBack);
const plannerDialog = plannerDialogBack.querySelector('.planner-modal');

function wishlistStatus(item) {
  if (item.status === 'Purchased' || item.status === 'Cancelled') return item.status;
  return Number(item.amountSaved) >= Number(item.allocatedBudget) && Number(item.allocatedBudget) > 0
    ? 'Ready to Buy'
    : item.status;
}

function safePurchaseUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function wishlistDate(value, options = { month: 'long', year: 'numeric' }) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en', options);
}

function savingRecommendation(item) {
  if (!item.targetDate || !Number.isFinite(new Date(`${item.targetDate}T00:00:00`).getTime())) return null;
  const target = new Date(`${item.targetDate}T00:00:00`);
  const now = new Date();
  const months = Math.max(1, (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth());
  const remaining = Math.max(0, Number(item.allocatedBudget) - Number(item.amountSaved));
  return { months, monthly: Math.ceil(remaining / months) };
}

function openPlannerDialog(content) {
  plannerDialog.innerHTML = content;
  plannerDialogBack.classList.add('open');
  plannerDialogBack.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => plannerDialog.querySelector('input,select,button')?.focus());
}

function closePlannerDialog() {
  plannerDialogBack.classList.remove('open');
  plannerDialogBack.setAttribute('aria-hidden', 'true');
  plannerDialog.innerHTML = '';
}

function openWishlistForm(itemId = null) {
  const existing = itemId ? data.wishlist.find(item => String(item.id) === String(itemId)) : null;
  if (itemId && !existing) return;
  const priority = existing?.priority || 'Medium';
  const status = existing?.status || 'Planning';
  const field = (label, name, type, value = '', attrs = '') =>
    `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
  const priorityOptions = wishlistPriorities.map(value =>
    `<label><input type="radio" name="priority" value="${esc(value)}"${value === priority ? ' checked' : ''}><span class="priority-${value.toLowerCase().replaceAll(' ', '-')}">${esc(value)}</span></label>`
  ).join('');
  openPlannerDialog(`<div class="planner-modal-head"><div><h2 id="plannerDialogTitle">${existing ? 'Edit purchase plan' : 'Add Wishlist Item'}</h2><p>Plan the cost before it becomes a purchase.</p></div><button class="planner-close" type="button" data-planner-close aria-label="Close">×</button></div><form class="planner-form" id="wishlistForm">
    ${field('Item Name', 'name', 'text', existing?.name || '', 'maxlength="100" required placeholder="Laptop"')}
    <label>Description / Notes<textarea name="description" maxlength="500" placeholder="Used mainly for development and college work.">${esc(existing?.description || '')}</textarea></label>
    <div class="planner-form-grid"><label>Category<select name="category">${Object.keys(wishlistCategories).map(value => `<option value="${esc(value)}"${(existing?.category || 'Electronics') === value ? ' selected' : ''}>${esc(value)}</option>`).join('')}</select></label><label>Priority<div class="planner-priority-options">${priorityOptions}</div></label></div>
    <div class="planner-form-grid">${field('Estimated Cost · KSh', 'estimatedCost', 'number', existing?.estimatedCost ?? '', 'min="0.01" step="0.01" required placeholder="0.00"')}${field('Allocated Budget · KSh', 'allocatedBudget', 'number', existing?.allocatedBudget ?? '', 'min="0.01" step="0.01" required placeholder="0.00"')}</div>
    <div class="planner-form-grid">${field('Amount Saved · KSh', 'amountSaved', 'number', existing?.amountSaved ?? 0, `min="0" step="0.01" max="${esc(existing?.allocatedBudget ?? '')}" required placeholder="0.00"`)}${field('Target Purchase Date', 'targetDate', 'date', existing?.targetDate || '', '')}</div>
    <div class="planner-form-grid"><label>Purchase Status<select name="status">${wishlistStatuses.map(value => `<option value="${esc(value)}"${status === value ? ' selected' : ''}>${esc(value)}</option>`).join('')}</select></label>${field('Purchase Link · optional', 'purchaseLink', 'url', existing?.purchaseLink || '', 'maxlength="500" placeholder="https://example.com/item"')}</div>
    <label>Notes · optional<textarea name="notes" maxlength="1000" placeholder="Any extra details for this purchase plan.">${esc(existing?.notes || '')}</textarea></label>
    <div class="planner-form-actions"><button class="ghost" type="button" data-planner-close>Cancel</button><button class="primary planner-add" type="submit">${existing ? 'Save Changes' : 'Save Item'}</button></div>
  </form>`);
  const form = document.getElementById('wishlistForm');
  const budgetInput = form.elements.namedItem('allocatedBudget');
  const savedInput = form.elements.namedItem('amountSaved');
  budgetInput.addEventListener('input', () => { savedInput.max = budgetInput.value; });
  form.onsubmit = event => {
    event.preventDefault();
    const values = new FormData(form);
    const allocatedBudget = Number(values.get('allocatedBudget'));
    const estimatedCost = Number(values.get('estimatedCost'));
    const amountSaved = Number(values.get('amountSaved'));
    if (!Number.isFinite(allocatedBudget) || allocatedBudget <= 0 ||
        !Number.isFinite(estimatedCost) || estimatedCost <= 0 ||
        !Number.isFinite(amountSaved) || amountSaved < 0 || amountSaved > allocatedBudget) {
      toast('Enter valid amounts; saved money cannot exceed the allocated budget.');
      return;
    }
    const selectedStatus = String(values.get('status'));
    if (selectedStatus === 'Ready to Buy' && amountSaved < allocatedBudget) {
      toast('Save the full allocated budget before marking this item ready to buy.');
      return;
    }
    const item = {
      id: existing?.id || crypto.randomUUID(),
      name: String(values.get('name')).trim(),
      description: String(values.get('description') || '').trim(),
      category: String(values.get('category')),
      estimatedCost,
      allocatedBudget,
      amountSaved,
      priority: String(values.get('priority') || 'Medium'),
      targetDate: String(values.get('targetDate') || ''),
      status: amountSaved >= allocatedBudget && !['Purchased', 'Cancelled'].includes(selectedStatus)
        ? 'Ready to Buy'
        : selectedStatus,
      purchaseLink: String(values.get('purchaseLink') || '').trim(),
      notes: String(values.get('notes') || '').trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!item.name) {
      toast('Enter an item name to save this plan.');
      return;
    }
    if (existing) Object.assign(existing, item);
    else data.wishlist.push(item);
    data.deleted.wishlist = data.deleted.wishlist.filter(id => id !== String(item.id));
    closePlannerDialog();
    save();
    showScreen('planner');
    toast(existing ? 'Purchase plan updated' : 'Wishlist item saved');
  };
}

function addWishlistMoney(itemId) {
  const item = data.wishlist.find(record => String(record.id) === String(itemId));
  if (!item) return;
  const remaining = Math.max(0, Number(item.allocatedBudget) - Number(item.amountSaved));
  openPlannerDialog(`<div class="planner-modal-head"><div><h2 id="plannerDialogTitle">Add to your plan</h2><p>${esc(item.name)} · ${money(item.amountSaved)} saved of ${money(item.allocatedBudget)}</p></div><button class="planner-close" type="button" data-planner-close aria-label="Close">×</button></div><form class="planner-form" id="wishlistMoneyForm"><label>Amount to set aside · KSh<input name="amount" type="number" min="0.01" max="${remaining}" step="0.01" required placeholder="0.00"></label><div class="planner-form-actions"><button class="ghost" type="button" data-planner-close>Cancel</button><button class="primary planner-add" type="submit">Add Money</button></div></form>`);
  document.getElementById('wishlistMoneyForm').onsubmit = event => {
    event.preventDefault();
    const amount = Number(new FormData(event.currentTarget).get('amount'));
    if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
      toast(`Enter an amount up to ${money(remaining)}.`);
      return;
    }
    item.amountSaved = Math.min(Number(item.allocatedBudget), Number(item.amountSaved) + amount);
    item.updatedAt = new Date().toISOString();
    if (item.amountSaved >= item.allocatedBudget && !['Purchased', 'Cancelled'].includes(item.status)) item.status = 'Ready to Buy';
    closePlannerDialog();
    save();
    toast(item.status === 'Ready to Buy' ? 'Your planned budget is fully saved' : 'Savings added to your plan');
  };
}

function canAffordWishlistItem(itemId) {
  const item = data.wishlist.find(record => String(record.id) === String(itemId));
  if (!item) return;
  const monthlyNet = Math.max(0, totals().balance);
  const thisMonth = monthKey();
  const otherPlans = data.wishlist.filter(record =>
    String(record.id) !== String(item.id) &&
    !['Purchased', 'Cancelled'].includes(wishlistStatus(record)) &&
    record.targetDate?.slice(0, 7) === thisMonth
  ).reduce((sum, record) => sum + Number(record.allocatedBudget), 0);
  const allowance = Math.max(0, monthlyNet - otherPlans);
  const cost = Number(item.estimatedCost);
  const share = allowance > 0 ? Math.round(cost / allowance * 100) : 0;
  const comfortable = allowance > 0 && cost <= allowance;
  const result = comfortable
    ? ['comfortable', 'Looks Comfortable', 'This purchase fits within the current monthly amount left after your other planned purchases.']
    : allowance > 0
      ? ['caution', 'Be Careful', `This purchase would take up about ${Math.min(999, share)}% of your estimated monthly spending allowance after other planned purchases.`]
      : ['unavailable', 'Not Enough Information', 'SpendWise does not show a positive net cash flow for this month, so it cannot estimate an available spending allowance.'];
  openPlannerDialog(`<div class="planner-modal-head"><div><h2 id="plannerDialogTitle">Can I Afford It?</h2><p>Planning estimate for ${esc(item.name)}</p></div><button class="planner-close" type="button" data-planner-close aria-label="Close">×</button></div><div class="planner-alert ${result[0]}"><h3>${result[1]}</h3><p>${result[2]}</p><div class="planner-stat-line"><span>Estimated purchase cost</span><strong>${money(cost)}</strong></div><div class="planner-stat-line"><span>Monthly net cash flow</span><strong>${money(monthlyNet)}</strong></div><div class="planner-stat-line"><span>Other purchases planned this month</span><strong>${money(otherPlans)}</strong></div><div class="planner-stat-line"><span>Estimated amount left for plans</span><strong>${money(allowance)}</strong></div><small>Estimate uses only income and expenses currently recorded for this month in SpendWise. It does not account for bills or financial circumstances not recorded in the app and is not financial advice.</small></div><div class="planner-form-actions"><button class="primary planner-add" type="button" data-planner-close>Got it</button></div>`);
}

function deleteWishlistItem(itemId) {
  const item = data.wishlist.find(record => String(record.id) === String(itemId));
  if (!item) return;
  data.deleted.wishlist = [...new Set([...data.deleted.wishlist, String(item.id)])];
  data.wishlist = data.wishlist.filter(record => String(record.id) !== String(item.id));
  save();
  toast('Wishlist item removed');
}

function markWishlistPurchased(itemId) {
  const item = data.wishlist.find(record => String(record.id) === String(itemId));
  if (!item) return;
  item.status = 'Purchased';
  item.updatedAt = new Date().toISOString();
  save();
  toast('Moved to Purchased Items');
}

function renderWishlist(animateCounters = true) {
  const activeItems = data.wishlist.filter(item => !['Purchased', 'Cancelled'].includes(wishlistStatus(item)));
  const total = activeItems.reduce((sum, item) => sum + Number(item.allocatedBudget || 0), 0);
  const saved = activeItems.reduce((sum, item) => sum + Number(item.amountSaved || 0), 0);
  const remaining = Math.max(0, total - saved);
  const progress = total > 0 ? Math.min(100, saved / total * 100) : 0;
  const values = [
    [plannerTotal, total, money],
    [plannerSaved, saved, money],
    [plannerRemaining, remaining, money],
    [plannerCount, activeItems.length, value => String(Math.round(value))]
  ];
  values.forEach(([element, value, formatter]) => {
    if (!animateCounters || !Number.isFinite(value)) {
      element.textContent = formatter(value);
      return;
    }
    const start = performance.now();
    const duration = 430;
    const tick = now => {
      const ratio = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - ratio) ** 3;
      element.textContent = formatter(value * eased);
      if (ratio < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  plannerSavedLabel.textContent = money(saved);
  plannerPlannedLabel.textContent = money(total);
  plannerOverallProgress.style.width = `${progress}%`;
  plannerOverallProgress.parentElement.setAttribute('aria-valuenow', String(Math.round(progress)));

  const filterHost = plannerPriorityFilters;
  filterHost.innerHTML = ['All', ...wishlistPriorities].map(label => {
    const value = label === 'All' ? 'all' : label;
    return `<button type="button" class="planner-filter${wishlistPriorityFilter === value ? ' active' : ''}" data-priority-filter="${esc(value)}" aria-pressed="${wishlistPriorityFilter === value}">${esc(label)}</button>`;
  }).join('');

  const search = plannerSearch.value.trim().toLowerCase();
  const statusFilter = plannerStatusFilter.value;
  const filtered = data.wishlist.filter(item => {
    const matchesPriority = wishlistPriorityFilter === 'all' || item.priority === wishlistPriorityFilter;
    const matchesStatus = statusFilter === 'all' || wishlistStatus(item) === statusFilter;
    const searchable = `${item.name} ${item.category} ${item.notes || ''} ${item.description || ''}`.toLowerCase();
    return matchesPriority && matchesStatus && searchable.includes(search);
  });
  const sort = plannerSort.value;
  const priorityRank = Object.fromEntries(wishlistPriorities.map((value, index) => [value, index]));
  const byRecent = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'budget-high') return Number(b.allocatedBudget) - Number(a.allocatedBudget) || byRecent(a, b);
    if (sort === 'budget-low') return Number(a.allocatedBudget) - Number(b.allocatedBudget) || byRecent(a, b);
    if (sort === 'date') return (a.targetDate || '9999-12-31').localeCompare(b.targetDate || '9999-12-31') || byRecent(a, b);
    if (sort === 'priority') return (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99) || byRecent(a, b);
    if (sort === 'progress') return Number(b.amountSaved) / Math.max(1, Number(b.allocatedBudget)) - Number(a.amountSaved) / Math.max(1, Number(a.allocatedBudget)) || byRecent(a, b);
    return byRecent(a, b);
  });
  plannerResultCount.textContent = `${sorted.length} ${sorted.length === 1 ? 'item' : 'items'}`;
  plannerListTitle.textContent = statusFilter === 'all' && wishlistPriorityFilter === 'all'
    ? 'Active purchase plans'
    : 'Filtered purchase plans';

  const itemCard = (item, index) => {
    const allocated = Number(item.allocatedBudget) || 0;
    const amountSaved = Number(item.amountSaved) || 0;
    const estimated = Number(item.estimatedCost) || 0;
    const itemRemaining = Math.max(0, allocated - amountSaved);
    const itemProgress = allocated > 0 ? Math.min(100, amountSaved / allocated * 100) : 0;
    const status = wishlistStatus(item);
    const aboveBudget = estimated > allocated;
    const date = wishlistDate(item.targetDate);
    const recommendation = savingRecommendation(item);
    const link = safePurchaseUrl(item.purchaseLink);
    const stateBadge = status === 'Purchased' ? 'status-purchased'
      : status === 'Ready to Buy' ? 'status-ready-to-buy'
        : status === 'Cancelled' ? 'status-cancelled'
          : status === 'Saving' ? 'status-saving' : '';
    return `<article class="wishlist-card${status === 'Purchased' ? ' purchased' : ''}" style="animation-delay:${Math.min(index, 6) * 35}ms">
      <div class="wishlist-head"><span class="wishlist-category-icon">${svgIcon(wishlistCategories[item.category] || 'shapes')}</span><div class="wishlist-title"><h4>${esc(item.name)}</h4><p>${esc(item.category)} · ${esc(item.priority)} Priority</p></div><div class="wishlist-badges"><span class="wishlist-badge priority-${String(item.priority || 'medium').toLowerCase().replaceAll(' ', '-')}">${esc(item.priority || 'Medium')}</span><span class="wishlist-badge ${stateBadge}">${esc(status)}</span></div></div>
      ${item.description ? `<p class="planner-disclaimer">${esc(item.description)}</p>` : ''}
      <div class="wishlist-finances"><div class="wishlist-finance"><small>Allocated budget</small><b>${money(allocated)}</b></div><div class="wishlist-finance"><small>Saved so far</small><b class="positive">${money(amountSaved)}</b></div><div class="wishlist-finance"><small>Remaining</small><b class="${itemRemaining === 0 ? 'positive' : ''}">${money(itemRemaining)}</b></div></div>
      <div class="planner-track" role="progressbar" aria-label="${esc(item.name)} savings progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(itemProgress)}"><i style="width:${itemProgress}%"></i></div><div class="wishlist-progress-label"><span>${Math.round(itemProgress)}% funded</span><span>Estimated cost ${money(estimated)}</span></div>
      ${aboveBudget ? `<div class="wishlist-warning">Budget Alert · This item is ${money(estimated - allocated)} above your allocated budget.</div>` : status === 'Ready to Buy' ? '<div class="wishlist-warning ready">Ready to Buy · You’ve reached your planned budget for this purchase.</div>' : ''}
      ${recommendation && status !== 'Purchased' && status !== 'Cancelled' && itemRemaining > 0 ? `<div class="wishlist-saving-plan"><strong>Save ${money(recommendation.monthly)}/month to reach your target.</strong><small>${recommendation.months} ${recommendation.months === 1 ? 'month' : 'months'} remaining · ${esc(date)}</small></div>` : ''}
      <div class="wishlist-meta">${date ? `<span>${svgIcon('planner')} Target: ${esc(date)}</span>` : '<span>No target date set</span>'}${link ? `<a class="wishlist-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${svgIcon('search')} Purchase link</a>` : ''}</div>
      ${item.notes ? `<div class="planner-disclaimer">Note · ${esc(item.notes)}</div>` : ''}
      <div class="wishlist-actions">${status !== 'Purchased' && status !== 'Cancelled' ? `<button class="planner-action money" type="button" data-wishlist-action="money" data-id="${esc(item.id)}">${svgIcon('goals')} Add Money</button>` : ''}<button class="planner-action" type="button" data-wishlist-action="afford" data-id="${esc(item.id)}">Can I Afford It?</button><button class="planner-action" type="button" data-wishlist-action="edit" data-id="${esc(item.id)}">${svgIcon('settings')} Edit</button>${status !== 'Purchased' && status !== 'Cancelled' ? `<button class="planner-action buy" type="button" data-wishlist-action="purchase" data-id="${esc(item.id)}">${svgIcon('goals')} Mark Purchased</button>` : ''}<button class="planner-action delete" type="button" data-wishlist-action="delete" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.name)}" title="Delete">${svgIcon('close')}</button></div>
    </article>`;
  };

  const purchasedItems = sorted.filter(item => wishlistStatus(item) === 'Purchased');
  const visibleItems = sorted.filter(item => wishlistStatus(item) !== 'Purchased');
  if (!data.wishlist.length) {
    plannerItems.innerHTML = `<div class="planner-empty"><div class="planner-empty-mark">${svgIcon('planner')}</div><h3>Nothing planned yet.</h3><p>Start building your purchase plan. Add something you want, set a budget, and let SpendWise help you buy it without losing control of your money.</p><button class="primary planner-add" type="button" data-planner-add>+ Add Your First Item</button></div>`;
  } else if (!sorted.length) {
    plannerItems.innerHTML = `<div class="planner-empty"><div class="planner-empty-mark">${svgIcon('search')}</div><h3>No matching plans.</h3><p>Try another search or adjust your filters to see more items.</p><button class="ghost" type="button" data-planner-clear>Clear filters</button></div>`;
  } else {
    plannerItems.innerHTML = visibleItems.map(itemCard).join('') || '<div class="planner-no-data">No active plans match these filters.</div>';
  }
  plannerPurchasedSection.hidden = !purchasedItems.length || wishlistPriorityFilter !== 'all' || search.length > 0 || (statusFilter !== 'all' && statusFilter !== 'Purchased');
  plannerPurchased.innerHTML = purchasedItems.map(itemCard).join('');
  renderWishlistInsights();
}

function renderWishlistInsights() {
  const upcoming = data.wishlist.filter(item =>
    item.targetDate &&
    !['Purchased', 'Cancelled'].includes(wishlistStatus(item)) &&
    wishlistDate(item.targetDate)
  ).sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const grouped = new Map();
  upcoming.forEach(item => {
    const key = item.targetDate.slice(0, 7);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  plannerTimeline.innerHTML = [...grouped.entries()].map(([key, items]) =>
    `<div class="planner-month"><h4>${esc(wishlistDate(`${key}-01`))}</h4>${items.map(item => `<div class="planner-month-item"><span>${svgIcon(wishlistCategories[item.category] || 'shapes')}${esc(item.name)}</span><span>${money(item.allocatedBudget)}</span></div>`).join('')}</div>`
  ).join('') || '<div class="planner-no-data">Add a target date to see upcoming purchases here.</div>';

  const monthly = new Map();
  data.wishlist.filter(item => item.targetDate && !['Purchased', 'Cancelled'].includes(wishlistStatus(item)))
    .forEach(item => {
      const key = item.targetDate.slice(0, 7);
      monthly.set(key, (monthly.get(key) || 0) + Number(item.allocatedBudget || 0));
    });
  const highest = Math.max(0, ...monthly.values());
  plannerMonthlyChart.innerHTML = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, amount]) =>
    `<div class="planner-chart-row"><span>${esc(wishlistDate(`${key}-01`))}</span><div class="planner-chart-track"><i style="width:${highest ? amount / highest * 100 : 0}%"></i></div><strong>${money(amount)}</strong></div>`
  ).join('') || '<div class="planner-no-data">Set target dates to see your purchase plan by month.</div>';
}

function bindWishlistControls() {
  plannerSearch.addEventListener('input', () => renderWishlist(false));
  plannerStatusFilter.addEventListener('change', () => renderWishlist(false));
  plannerSort.addEventListener('change', () => renderWishlist(false));
  plannerPriorityFilters.addEventListener('click', event => {
    const button = event.target.closest('[data-priority-filter]');
    if (!button) return;
    wishlistPriorityFilter = button.dataset.priorityFilter;
    renderWishlist(false);
  });
  plannerItems.addEventListener('click', event => handleWishlistAction(event));
  plannerPurchased.addEventListener('click', event => handleWishlistAction(event));
  plannerScreen.addEventListener('click', event => {
    if (event.target.closest('[data-planner-add]')) {
      openWishlistForm();
      return;
    }
    if (event.target.closest('[data-planner-clear]')) {
      plannerSearch.value = '';
      plannerStatusFilter.value = 'all';
      plannerSort.value = 'recent';
      wishlistPriorityFilter = 'all';
      renderWishlist(false);
    }
  });
  plannerDialogBack.addEventListener('click', event => {
    if (event.target === plannerDialogBack || event.target.closest('[data-planner-close]')) closePlannerDialog();
  });
  plannerDialogBack.addEventListener('submit', event => {
    if (event.target.id !== 'wishlistForm') return;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && plannerDialogBack.classList.contains('open')) closePlannerDialog();
  });
}

function handleWishlistAction(event) {
  const button = event.target.closest('[data-wishlist-action]');
  if (!button) return;
  const { wishlistAction, id } = button.dataset;
  if (wishlistAction === 'money') addWishlistMoney(id);
  if (wishlistAction === 'edit') openWishlistForm(id);
  if (wishlistAction === 'purchase') markWishlistPurchased(id);
  if (wishlistAction === 'delete') deleteWishlistItem(id);
  if (wishlistAction === 'afford') canAffordWishlistItem(id);
}

const initialRender = render;
render = function renderSpendWise() {
  initialRender();
  renderDebts();
  renderWishlist();
  const firstName = data.userName?.trim().split(/\s+/)[0];
  document.getElementById('greeting').textContent = `${greeting()}${firstName ? `, ${firstName}` : ''}`;
  const nameInput = document.querySelector('#nameForm [name="name"]');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = data.userName || '';
  const currency = document.getElementById('currency');
  if (currency) currency.selectedIndex = { KSh: 0, '$': 1, '€': 2, '£': 3 }[data.currency] ?? 0;
  decorateCategoryIcons();
};

const initialShowScreen = showScreen;
showScreen = function showSpendWiseScreen(id) {
  if (!document.getElementById(id)) return;
  initialShowScreen(id);
  document.body.classList.toggle('entry-mode', id === 'welcome');
  const more = mobileNav.querySelector('[data-more]');
  if (more) {
    more.classList.toggle('active', mobileSecondary.some(([screen]) => screen === id));
    more.setAttribute('aria-expanded', 'false');
  }
  mobileNav.classList.remove('menu-open');
  if (id === 'settings') updateAccountControls();
};

function openBudget() {
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Set monthly budget</h2><form class="form" id="budgetForm"><label>Category<select name="category">${data.categories.map(category => `<option>${esc(category.name)}</option>`).join('')}</select></label><label>Budget amount<input name="amount" type="number" min="0" step="0.01" required placeholder="0.00"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save budget</button></div></form>`;
  document.getElementById('budgetForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const category = values.get('category');
    data.deleted.budgets = data.deleted.budgets.filter(item => item !== category);
    data.budgets = data.budgets.filter(budget => budget.category !== category);
    data.budgets.push({ category, amount: Number(values.get('amount')) });
    closeModal();
    save();
    toast('Budget saved');
  };
}

function openGoal() {
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Create savings goal</h2><form class="form" id="goalForm"><label>Goal name<input name="name" required placeholder="e.g. New laptop"></label><div class="form-grid"><label>Target amount<input name="target" type="number" min="0" step="0.01" required></label><label>Already saved<input name="saved" type="number" min="0" step="0.01" value="0"></label></div><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Create goal</button></div></form>`;
  document.getElementById('goalForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    data.goals.push({
      id: crypto.randomUUID(),
      name: values.get('name'),
      target: Number(values.get('target')),
      saved: Number(values.get('saved'))
    });
    closeModal();
    save();
    toast('Goal created');
  };
}

function openCategory() {
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Create category</h2><form class="form" id="catForm"><label>Name<input name="name" required placeholder="Side hustle"></label><label>Icon<input name="icon" maxlength="3" value="•"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Create</button></div></form>`;
  document.getElementById('catForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name')).trim();
    if (data.categories.some(category => category.name.toLowerCase() === name.toLowerCase())) {
      toast('That category already exists');
      return;
    }
    data.deleted.categories = data.deleted.categories.filter(item => item !== name);
    data.categories.push({ name, icon: values.get('icon') || '•' });
    closeModal();
    save();
    toast('Category created');
  };
}

deleteTx = function deleteTransaction(id) {
  data.deleted.transactions = [...new Set([...data.deleted.transactions, String(id)])];
  data.transactions = data.transactions.filter(item => String(item.id) !== String(id));
  save();
  toast('Transaction deleted');
};

deleteCategory = function deleteSpendingCategory(name) {
  if (data.transactions.some(item => item.category === name)) {
    toast('Move existing transactions first');
    return;
  }
  data.deleted.categories = [...new Set([...data.deleted.categories, String(name)])];
  data.categories = data.categories.filter(item => item.name !== name);
  save();
  toast('Category deleted');
};

deleteGoal = function deleteSavingsGoal(index) {
  const goal = data.goals[index];
  if (!goal) return;
  data.deleted.goals = [...new Set([...data.deleted.goals, String(goal.id)])];
  data.goals.splice(index, 1);
  save();
  toast('Goal deleted');
};

addGoalProgress = function addSavingsProgress(index) {
  const goal = data.goals[index];
  if (!goal) return;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Add to your goal</h2><form class="form" id="progressForm"><p class="muted">${esc(goal.name)} · ${money(goal.saved)} saved</p><label>Amount to add<input name="amount" type="number" min="0.01" step="0.01" required autofocus placeholder="0.00"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Update goal</button></div></form>`;
  document.getElementById('progressForm').onsubmit = event => {
    event.preventDefault();
    goal.saved += Number(new FormData(event.currentTarget).get('amount'));
    closeModal();
    save();
    toast('Goal updated');
  };
};

resetData = function resetSpendWiseData() {
  if (!confirm('Reset all spending data on this account and device? This cannot be undone.')) return;
  for (const item of data.transactions) data.deleted.transactions.push(String(item.id));
  const defaultCategories = new Set(DEFAULT_CATS.map(([name]) => name));
  for (const item of data.categories) {
    if (!defaultCategories.has(item.name)) data.deleted.categories.push(String(item.name));
  }
  for (const item of data.budgets) data.deleted.budgets.push(String(item.category));
  for (const item of data.goals) data.deleted.goals.push(String(item.id));
  for (const item of data.debts) data.deleted.debts.push(String(item.id));
  for (const item of data.wishlist) data.deleted.wishlist.push(String(item.id));
  data.deleted.categories = data.deleted.categories.filter(name => !defaultCategories.has(name));
  const { userName, currency, deleted } = data;
  data = { ...createStarterData(), userName, currency, deleted };
  save();
  toast('Your data was reset');
};

function openTransaction(type = 'expense') {
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Add ${type}</h2><form class="form" id="transactionForm"><div class="form-grid"><label>Amount<input name="amount" type="number" step="0.01" min="0.01" required autofocus placeholder="0.00"></label><label>Date<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label></div><label>Description<input name="title" required placeholder="e.g. Lunch, salary, fuel"></label><label>Category<select name="category">${data.categories.map(category => `<option>${esc(category.name)}</option>`).join('')}</select></label><label>Note<textarea name="note" rows="2" placeholder="Optional"></textarea></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save ${type}</button></div></form>`;
  document.getElementById('transactionForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    data.transactions.push({
      id: crypto.randomUUID(),
      type,
      amount: Number(values.get('amount')),
      date: values.get('date'),
      title: String(values.get('title')).trim(),
      category: values.get('category'),
      note: values.get('note')
    });
    closeModal();
    save();
    toast('Transaction saved locally');
  };
}

function actionButtons(recordType, id) {
  return `<span class="row-actions"><button class="iconbtn" type="button" data-action="edit-${recordType}" data-id="${esc(id)}" aria-label="Edit ${recordType}" title="Edit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button><button class="iconbtn delete-action" type="button" data-action="delete-${recordType}" data-id="${esc(id)}" aria-label="Delete ${recordType}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></span>`;
}

txHTML = function renderTransactionRow(transaction) {
  const category = data.categories.find(item => item.name === transaction.category);
  return `<div class="tx"><div class="avatar">${esc(category?.icon || '•')}</div><div class="tx-main"><strong>${esc(transaction.title)}</strong><small>${esc(transaction.category)} · ${new Date(transaction.date).toLocaleDateString('en-KE')}</small></div><span class="amount ${transaction.type}">${transaction.type === 'income' ? '+' : '−'}${money(transaction.amount)}</span>${actionButtons('transaction', transaction.id)}</div>`;
};

renderCategories = function renderSpendCategories() {
  const totals = data.transactions.filter(item => item.type === 'expense').reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + Number(item.amount);
    return result;
  }, {});
  const total = Object.values(totals).reduce((sum, amount) => sum + amount, 0);
  categorySummary.innerHTML = data.categories.map(category => {
    const amount = totals[category.name] || 0;
    const percent = total ? amount / total * 100 : 0;
    return `<div><div class="cat-row"><span>${esc(category.icon)}</span><strong>${esc(category.name)}</strong><b>${money(amount)}</b></div><div class="bar"><i style="width:${percent}%"></i></div></div>`;
  }).join('') || '<div class="empty">No spending data yet.</div>';
  categoryPage.innerHTML = data.categories.map(category =>
    `<div class="tx"><div class="avatar">${esc(category.icon)}</div><div class="tx-main"><strong>${esc(category.name)}</strong><small>${money(totals[category.name] || 0)} spent</small></div>${actionButtons('category', category.name)}</div>`
  ).join('');
};

renderBudgets = function renderSpendBudgets() {
  const currentMonth = monthKey();
  budgetPage.innerHTML = data.budgets.map(budget => {
    const spent = data.transactions.filter(item =>
      item.type === 'expense' && item.category === budget.category && item.date.slice(0, 7) === currentMonth
    ).reduce((sum, item) => sum + Number(item.amount), 0);
    const percent = Math.min(100, budget.amount ? spent / budget.amount * 100 : 0);
    return `<div class="card budget-card"><div class="cat-row"><span>◷</span><strong>${esc(budget.category)}</strong><b>${money(spent)} / ${money(budget.amount)}</b>${actionButtons('budget', budget.category)}</div><div class="progress"><i style="width:${percent}%"></i></div><small class="muted">${percent.toFixed(0)}% used this month</small></div>`;
  }).join('') || '<div class="empty">No budgets yet. Set one to give your spending a boundary.</div>';
};

renderGoals = function renderSpendGoals() {
  goalPage.innerHTML = data.goals.map((goal, index) => {
    const percent = Math.min(100, goal.target ? goal.saved / goal.target * 100 : 0);
    return `<div class="card goal-card"><div class="section-head"><div><h3 style="margin:0">${esc(goal.name)}</h3><small class="muted">Target ${money(goal.target)}</small></div>${actionButtons('goal', goal.id)}</div><div class="progress"><i style="width:${percent}%"></i></div><div class="goal-meta"><small>${money(goal.saved)} saved</small><small class="muted">${percent.toFixed(0)}%</small></div><button class="ghost goal-progress" type="button" onclick="addGoalProgress(${index})">+ Add progress</button></div>`;
  }).join('') || '<div class="empty">No goals yet. Give yourself something worth saving for.</div>';
};

openTransaction = function openTransactionForm(type = 'expense', transactionId = null) {
  const existing = transactionId ? data.transactions.find(item => String(item.id) === String(transactionId)) : null;
  if (transactionId && !existing) return;
  const selectedType = existing?.type || type;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>${existing ? 'Edit' : 'Add'} ${selectedType}</h2><form class="form" id="transactionForm"><div class="form-grid"><label>Amount<input name="amount" type="number" step="0.01" min="0.01" required autofocus placeholder="0.00" value="${existing ? esc(existing.amount) : ''}"></label><label>Date<input name="date" type="date" value="${esc(existing?.date || new Date().toISOString().slice(0, 10))}" required></label></div><label>Description<input name="title" required placeholder="e.g. Lunch, salary, fuel" value="${esc(existing?.title || '')}"></label><label>Category<select name="category">${data.categories.map(category => `<option value="${esc(category.name)}"${category.name === existing?.category ? ' selected' : ''}>${esc(category.name)}</option>`).join('')}</select></label><label>Note<textarea name="note" rows="2" placeholder="Optional">${esc(existing?.note || '')}</textarea></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">${existing ? 'Save changes' : `Save ${selectedType}`}</button></div></form>`;
  document.getElementById('transactionForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const updated = {
      id: existing?.id || crypto.randomUUID(),
      type: selectedType,
      amount: Number(values.get('amount')),
      date: values.get('date'),
      title: String(values.get('title')).trim(),
      category: values.get('category'),
      note: String(values.get('note') || '').trim()
    };
    if (existing) Object.assign(existing, updated);
    else data.transactions.push(updated);
    data.deleted.transactions = data.deleted.transactions.filter(id => id !== String(updated.id));
    closeModal();
    save();
    toast(existing ? 'Transaction updated' : 'Transaction saved locally');
  };
};

function openEditCategory(categoryName) {
  const category = data.categories.find(item => item.name === categoryName);
  if (!category) return;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Edit category</h2><form class="form" id="editCategoryForm"><label>Name<input name="name" maxlength="60" required value="${esc(category.name)}"></label><label>Icon<input name="icon" maxlength="3" value="${esc(category.icon || '•')}"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save changes</button></div></form>`;
  document.getElementById('editCategoryForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const newName = String(values.get('name')).trim();
    if (data.categories.some(item => item !== category && item.name.toLowerCase() === newName.toLowerCase())) {
      toast('That category already exists');
      return;
    }
    const oldName = category.name;
    if (newName !== oldName) {
      data.deleted.categories = [...new Set([...data.deleted.categories, oldName])].filter(name => name !== newName);
      data.deleted.budgets = [...new Set([...data.deleted.budgets, oldName])].filter(name => name !== newName);
      data.transactions.forEach(item => { if (item.category === oldName) item.category = newName; });
      data.budgets.forEach(item => { if (item.category === oldName) item.category = newName; });
      category.name = newName;
    }
    category.icon = String(values.get('icon') || '•').trim() || '•';
    closeModal();
    save();
    toast('Category updated');
  };
}

function openEditBudget(categoryName) {
  const budget = data.budgets.find(item => item.category === categoryName);
  if (!budget) return;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Edit monthly budget</h2><form class="form" id="editBudgetForm"><label>Category<select name="category">${data.categories.map(category => `<option value="${esc(category.name)}"${category.name === budget.category ? ' selected' : ''}>${esc(category.name)}</option>`).join('')}</select></label><label>Budget amount<input name="amount" type="number" min="0" step="0.01" required value="${esc(budget.amount)}"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save changes</button></div></form>`;
  document.getElementById('editBudgetForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const newCategory = String(values.get('category'));
    if (data.budgets.some(item => item !== budget && item.category === newCategory)) {
      toast('A budget already exists for that category');
      return;
    }
    data.deleted.budgets = data.deleted.budgets.filter(item => item !== newCategory);
    if (budget.category !== newCategory) {
      data.deleted.budgets = [...new Set([...data.deleted.budgets, budget.category])];
      budget.category = newCategory;
    }
    budget.amount = Number(values.get('amount'));
    closeModal();
    save();
    toast('Budget updated');
  };
}

function openEditGoal(goalId) {
  const goal = data.goals.find(item => String(item.id) === String(goalId));
  if (!goal) return;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>Edit savings goal</h2><form class="form" id="editGoalForm"><label>Goal name<input name="name" required value="${esc(goal.name)}"></label><div class="form-grid"><label>Target amount<input name="target" type="number" min="0" step="0.01" required value="${esc(goal.target)}"></label><label>Already saved<input name="saved" type="number" min="0" step="0.01" required value="${esc(goal.saved)}"></label></div><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save changes</button></div></form>`;
  document.getElementById('editGoalForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    goal.name = String(values.get('name')).trim();
    goal.target = Number(values.get('target'));
    goal.saved = Number(values.get('saved'));
    closeModal();
    save();
    toast('Goal updated');
  };
}

function deleteBudget(categoryName) {
  const budget = data.budgets.find(item => item.category === categoryName);
  if (!budget) return;
  data.deleted.budgets = [...new Set([...data.deleted.budgets, categoryName])];
  data.budgets = data.budgets.filter(item => item !== budget);
  save();
  toast('Budget deleted');
}

deleteCategory = function deleteSpendCategory(name) {
  if (data.transactions.some(item => item.category === name) || data.budgets.some(item => item.category === name)) {
    toast('Move transactions and remove the budget first');
    return;
  }
  data.deleted.categories = [...new Set([...data.deleted.categories, String(name)])];
  data.categories = data.categories.filter(item => item.name !== name);
  save();
  toast('Category deleted');
};

deleteGoal = function deleteSpendGoal(goalId) {
  const index = typeof goalId === 'number' ? goalId : data.goals.findIndex(item => String(item.id) === String(goalId));
  const goal = data.goals[index];
  if (!goal) return;
  data.deleted.goals = [...new Set([...data.deleted.goals, String(goal.id)])];
  data.goals.splice(index, 1);
  save();
  toast('Goal deleted');
};

function renderDebts() {
  const outstanding = data.debts.filter(debt => !debt.settled);
  const theyOwe = outstanding.filter(debt => debt.direction === 'owed-to-me');
  const iOwe = outstanding.filter(debt => debt.direction === 'i-owe');
  const owedTotal = theyOwe.reduce((sum, debt) => sum + Number(debt.amount), 0);
  const oweTotal = iOwe.reduce((sum, debt) => sum + Number(debt.amount), 0);
  const net = owedTotal - oweTotal;
  debtSummary.innerHTML = `<div class="debt-stat"><small>Owed to you</small><strong class="income">${money(owedTotal)}</strong></div><div class="debt-stat"><small>You owe</small><strong class="expense">${money(oweTotal)}</strong></div><div class="debt-stat"><small>Net difference</small><strong>${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</strong></div>`;

  const debtRow = debt => {
    const direction = debt.direction === 'owed-to-me' ? 'Owes you' : 'You owe';
    const due = debt.dueDate ? ` · due ${new Date(`${debt.dueDate}T00:00:00`).toLocaleDateString('en-KE')}` : '';
    return `<div class="tx debt-row${debt.settled ? ' debt-settled' : ''}"><span class="debt-type" aria-hidden="true">${debt.direction === 'owed-to-me' ? '↙' : '↗'}</span><div class="debt-meta"><strong>${esc(debt.person)} · ${money(debt.amount)}</strong><small>${direction}${esc(due)}${debt.note ? ` · ${esc(debt.note)}` : ''}${debt.settled ? ' · Settled' : ''}</small></div>${debt.settled ? '' : `<button class="ghost" type="button" data-action="settle-debt" data-id="${esc(debt.id)}">Mark settled</button>`}${actionButtons('debt', debt.id)}</div>`;
  };
  owedToMeList.innerHTML = theyOwe.map(debtRow).join('') || '<div class="empty">No one owes you right now.</div>';
  iOweList.innerHTML = iOwe.map(debtRow).join('') || '<div class="empty">You have no outstanding debts.</div>';
  settledDebtList.innerHTML = data.debts.filter(debt => debt.settled).map(debtRow).join('') || '<div class="empty">Settled items will show here.</div>';
}

function openDebt(debtId = null) {
  const existing = debtId ? data.debts.find(debt => String(debt.id) === String(debtId)) : null;
  if (debtId && !existing) return;
  modalBack.classList.add('open');
  modal.innerHTML = `<h2>${existing ? 'Edit debt' : 'Track a debt'}</h2><form class="form" id="debtForm"><label>Who is it with?<input name="person" maxlength="80" required autofocus value="${esc(existing?.person || '')}" placeholder="Person or business"></label><label>Which way does the money go?<select name="direction"><option value="owed-to-me"${existing?.direction !== 'i-owe' ? ' selected' : ''}>They owe me</option><option value="i-owe"${existing?.direction === 'i-owe' ? ' selected' : ''}>I owe them</option></select></label><div class="form-grid"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required value="${existing ? esc(existing.amount) : ''}"></label><label>Due date (optional)<input name="dueDate" type="date" value="${esc(existing?.dueDate || '')}"></label></div><label>Note (optional)<input name="note" maxlength="160" value="${esc(existing?.note || '')}" placeholder="What was it for?"></label><div class="modal-actions"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">${existing ? 'Save changes' : 'Save debt'}</button></div></form>`;
  document.getElementById('debtForm').onsubmit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const record = {
      id: existing?.id || crypto.randomUUID(),
      person: String(values.get('person')).trim(),
      direction: String(values.get('direction')),
      amount: Number(values.get('amount')),
      dueDate: String(values.get('dueDate') || ''),
      note: String(values.get('note') || '').trim(),
      settled: existing?.settled || false
    };
    if (existing) Object.assign(existing, record);
    else data.debts.push(record);
    data.deleted.debts = data.deleted.debts.filter(id => id !== String(record.id));
    closeModal();
    save();
    toast(existing ? 'Debt updated' : 'Debt saved on this device');
  };
}

function settleDebt(debtId) {
  const debt = data.debts.find(item => String(item.id) === String(debtId));
  if (!debt) return;
  debt.settled = true;
  save();
  toast('Marked as settled');
}

function deleteDebt(debtId) {
  data.deleted.debts = [...new Set([...data.deleted.debts, String(debtId)])];
  data.debts = data.debts.filter(item => String(item.id) !== String(debtId));
  save();
  toast('Debt deleted');
}

function downloadReportPdf() {
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) {
    toast('Allow pop-ups to prepare your PDF report');
    return;
  }
  const transactions = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date));
  const totals = transactions.reduce((result, item) => {
    result[item.type === 'income' ? 'income' : 'expenses'] += Number(item.amount);
    return result;
  }, { income: 0, expenses: 0 });
  const openDebts = data.debts.filter(debt => !debt.settled);
  const transactionRows = transactions.map(item =>
    `<tr><td>${esc(new Date(`${item.date}T00:00:00`).toLocaleDateString('en-KE'))}</td><td>${esc(item.title)}</td><td>${esc(item.category)}</td><td>${item.type === 'income' ? 'Income' : 'Expense'}</td><td class="amount">${esc(money(item.amount))}</td></tr>`
  ).join('') || '<tr><td colspan="5" class="empty">No transactions recorded yet.</td></tr>';
  const debtRows = openDebts.map(debt =>
    `<tr><td>${esc(debt.person)}</td><td>${debt.direction === 'owed-to-me' ? 'Owed to me' : 'I owe'}</td><td>${esc(debt.dueDate || '—')}</td><td class="amount">${esc(money(debt.amount))}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="empty">No outstanding debts.</td></tr>';
  const report = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SpendWise financial report</title><style>
    *{box-sizing:border-box}body{margin:0;padding:36px;color:#25213a;font:14px/1.5 Arial,sans-serif;background:#fff}
    header{display:flex;align-items:center;gap:16px;padding-bottom:22px;border-bottom:2px solid #eee8fa}
    header img{width:68px;height:68px;object-fit:cover;border-radius:18px}h1{margin:0;font-size:25px}header p{margin:3px 0;color:#77718b}
    .meta{margin:24px 0;color:#716b81}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 26px}
    .summary div{padding:15px;border:1px solid #e9e3f4;border-radius:14px;background:#faf8ff}
    .summary small{display:block;color:#77718b}.summary strong{display:block;margin-top:7px;font-size:19px}
    h2{margin:28px 0 10px;font-size:17px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #eeeaf4;font-size:12px}
    th{color:#6b6380;background:#f7f4fc}.amount{text-align:right;white-space:nowrap}.empty{text-align:center;color:#77718b;padding:18px}
    footer{margin-top:34px;padding-top:12px;border-top:1px solid #eeeaf4;color:#77718b;font-size:11px}
    @page{size:A4;margin:16mm}@media print{body{padding:0}}
  </style></head><body><header><img src="${new URL('give-money.png', location.href).href}" alt="SpendWise logo"><div><h1>SpendWise</h1><p>Personal finance report</p></div></header><p class="meta">Prepared for ${esc(data.userName || 'SpendWise user')} · ${new Date().toLocaleDateString('en-KE')}</p><div class="summary"><div><small>Total income</small><strong>${esc(money(totals.income))}</strong></div><div><small>Total expenses</small><strong>${esc(money(totals.expenses))}</strong></div><div><small>Net cash flow</small><strong>${esc(money(totals.income - totals.expenses))}</strong></div></div><h2>Transactions</h2><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Type</th><th class="amount">Amount</th></tr></thead><tbody>${transactionRows}</tbody></table><h2>Outstanding debts</h2><table><thead><tr><th>Person</th><th>Direction</th><th>Due date</th><th class="amount">Amount</th></tr></thead><tbody>${debtRows}</tbody></table><footer>Made by Shadrack Musembi-SpendWise 2026</footer><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250))<\/script></body></html>`;
  reportWindow.document.open();
  reportWindow.document.write(report);
  reportWindow.document.close();
}

function setTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem('spendwise-theme', selected);
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    const nextTheme = selected === 'dark' ? 'light' : 'dark';
    const icon = selected === 'dark'
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
      : '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>';
    toggle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${selected === 'dark' ? 'Light theme' : 'Dark theme'}</span>`;
    toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
    toggle.setAttribute('aria-pressed', String(selected === 'dark'));
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected === 'dark' ? '#10121b' : '#7657e8');
  if (document.getElementById('flowChart')) renderChart();
}

function installThemeToggle() {
  const button = document.createElement('button');
  button.id = 'themeToggle';
  button.type = 'button';
  button.className = 'ghost theme-toggle';
  button.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  installBtn.parentElement.insertBefore(button, installBtn);
  setTheme(localStorage.getItem('spendwise-theme') === 'dark' ? 'dark' : 'light');
}

renderChart = function renderThemeAwareChart() {
  const canvas = document.getElementById('flowChart');
  const context = canvas.getContext('2d');
  const ratio = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const keys = [...months()].reverse();
  const values = keys.map(key => totals(key));
  const maximum = Math.max(1, ...values.flatMap(value => [value.inc, value.exp]));
  const dark = document.documentElement.dataset.theme === 'dark';
  context.strokeStyle = dark ? '#34384b' : '#e4def6';
  context.lineWidth = 1;
  for (let index = 0; index < 5; index++) {
    const y = 20 + index * (height - 55) / 4;
    context.beginPath();
    context.moveTo(15, y);
    context.lineTo(width - 15, y);
    context.stroke();
  }
  for (const [key, color] of [['inc', dark ? '#5bd0a0' : '#218c68'], ['exp', dark ? '#ffb568' : '#f28c42']]) {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.beginPath();
    values.forEach((value, index) => {
      const x = 20 + index * (width - 40) / (values.length - 1);
      const y = height - 35 - (value[key] / maximum) * (height - 65);
      index ? context.lineTo(x, y) : context.moveTo(x, y);
    });
    context.stroke();
  }
  context.fillStyle = dark ? '#aaa6bb' : '#817991';
  context.font = '11px system-ui';
  keys.forEach((key, index) => {
    const x = 20 + index * (width - 40) / (keys.length - 1);
    context.fillText(key.slice(5), x - 7, height - 12);
  });
};

renderBudgetRing = function renderThemeAwareBudgetRing() {
  const key = budgetMonth.value || monthKey();
  const budgetTotal = data.budgets.reduce((sum, item) => sum + Number(item.amount), 0);
  const spent = data.transactions.filter(item => item.type === 'expense' && item.date.slice(0, 7) === key)
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const percent = budgetTotal ? Math.min(100, spent / budgetTotal * 100) : 0;
  ring.style.background = `conic-gradient(var(--blue) ${percent * 3.6}deg,var(--line) 0)`;
  budgetSpent.textContent = money(spent);
  budgetCaption.textContent = `of ${money(budgetTotal)}`;
};

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action][data-id]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'edit-transaction') openTransaction(data.transactions.find(item => String(item.id) === id)?.type || 'expense', id);
  if (action === 'delete-transaction') deleteTx(id);
  if (action === 'edit-category') openEditCategory(id);
  if (action === 'delete-category') deleteCategory(id);
  if (action === 'edit-budget') openEditBudget(id);
  if (action === 'delete-budget') deleteBudget(id);
  if (action === 'edit-goal') openEditGoal(id);
  if (action === 'delete-goal') deleteGoal(id);
  if (action === 'edit-debt') openDebt(id);
  if (action === 'delete-debt') deleteDebt(id);
  if (action === 'settle-debt') settleDebt(id);
});

async function handleAccountForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const action = form.dataset.mode === 'signup' ? 'signup' : 'signin';
  const submitter = form.querySelector('[data-auth-submit]') || document.getElementById('cloudAuthSubmit');
  if (submitter) submitter.disabled = true;
  setStatus(action === 'signup' ? 'Creating your account…' : 'Signing in…');
  try {
    const result = await apiRequest(`/api/auth/${action}`, {
      method: 'POST',
      body: JSON.stringify({
        email: String(values.get('email')).trim(),
        password: String(values.get('password'))
      })
    });
    if (result.confirmationRequired) {
      const message = 'Account started. Check your email to confirm it, then sign in here.';
      setStatus(message);
      document.getElementById('welcomeMessage').textContent = message;
      return;
    }
    cloudSession = { user: result.user };
    updateAccountControls();
    await syncNow();
    showScreen('dashboard');
    toast(action === 'signup' ? 'Account created and synced' : 'Signed in and synced');
  } catch (error) {
    console.error(`SpendWise ${action} failed:`, error);
    const message = action === 'signin' && /invalid login credentials/i.test(error.message)
      ? 'Email or password did not match an account. If you are new, switch this form to Create account and try again.'
      : error.message;
    setStatus(message, true);
    document.getElementById('welcomeMessage').textContent = message;
  } finally {
    if (submitter) submitter.disabled = false;
  }
}

function toggleAuthMode(form, toggle) {
  const creatingAccount = form.dataset.mode !== 'signup';
  form.dataset.mode = creatingAccount ? 'signup' : 'signin';
  const submit = form.querySelector('[data-auth-submit]') || document.getElementById('cloudAuthSubmit');
  submit.textContent = creatingAccount ? 'Create account' : 'Sign in';
  toggle.textContent = creatingAccount
    ? 'Already have an account? Sign in'
    : form.id === 'welcomeAuthForm' ? 'New to SpendWise? Create account' : 'New here? Create account';
  form.elements.namedItem('password').autocomplete = creatingAccount ? 'new-password' : 'current-password';
}

document.querySelectorAll('[data-auth-mode-toggle]').forEach(toggle => {
  toggle.addEventListener('click', () => toggleAuthMode(toggle.closest('form'), toggle));
});

async function restoreServerSession() {
  try {
    const result = await apiRequest('/api/session');
    if (!result.user) {
      cloudSession = null;
      updateAccountControls();
      setStatus(result.accountsConfigured
        ? 'Saved on this device · sign in to sync across devices.'
        : 'Saved on this device · account sync is not configured yet.');
      return;
    }
    cloudSession = { user: result.user };
    updateAccountControls();
    await syncNow();
    showScreen('dashboard');
  } catch (error) {
    cloudSession = null;
    updateAccountControls();
    if (!navigator.onLine || error.message.startsWith('Cannot reach the SpendWise account server')) {
      setStatus('Offline · sign in when connected, or continue offline on this device.');
    } else {
      console.error('SpendWise could not restore your account:', error);
      setStatus(error.message, true);
    }
  }
}

const accountDescription = document.querySelector('#settings .settings-card:last-child > p');
if (accountDescription) {
  accountDescription.textContent = 'Create a free account to keep your records in sync across devices. Your changes are saved on this device when you are offline.';
}

document.getElementById('cloudAuthSubmit').dataset.authSubmit = '';
document.getElementById('cloudModeToggle').dataset.authModeToggle = '';
document.getElementById('cloudAuthForm').addEventListener('submit', handleAccountForm);
document.getElementById('welcomeAuthForm').addEventListener('submit', handleAccountForm);
document.getElementById('continueOffline').addEventListener('click', () => {
  showScreen('dashboard');
  setStatus(navigator.onLine
    ? 'Using this device · changes are saved locally.'
    : 'Offline · changes are saved on this device.');
});
document.getElementById('addBtn').addEventListener('click', () => openTransaction('expense'));
document.getElementById('nameForm').addEventListener('submit', event => {
  event.preventDefault();
  data.userName = String(new FormData(event.currentTarget).get('name') || '').trim();
  save();
  toast('Name saved');
});
document.getElementById('currency').addEventListener('change', event => {
  data.currency = ['KSh', '$', '€', '£'][event.target.selectedIndex] || 'KSh';
  save();
  toast('Currency updated');
});
document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('importBtn').addEventListener('click', () => importFile.click());
document.getElementById('resetBtn').addEventListener('click', resetData);
document.getElementById('syncNowBtn').addEventListener('click', () => {
  syncNow().then(() => toast('Everything is up to date')).catch(error => {
    console.error('SpendWise sync failed:', error);
    setStatus(error.message, true);
  });
});
document.getElementById('signOutBtn').addEventListener('click', async () => {
  const previousUser = cloudSession?.user?.id;
  if (previousUser) {
    localStorage.setItem(`spendwise-data-${previousUser}`, JSON.stringify(data));
    localStorage.setItem('spendwise-active-user', previousUser);
  }
  try {
    await apiRequest('/api/auth/signout', { method: 'POST' });
    cloudSession = null;
    updateAccountControls();
    showScreen('welcome');
    setStatus('Signed out · your data is still saved on this device.');
  } catch (error) {
    console.error('SpendWise sign-out failed:', error);
    setStatus(error.message, true);
  }
});

importFile.onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.transactions) || !Array.isArray(imported.categories)) {
      throw new Error('This backup is missing required data.');
    }
    imported.transactions = imported.transactions.map(item => ({ ...item, id: item.id || crypto.randomUUID() }));
    imported.goals = (Array.isArray(imported.goals) ? imported.goals : [])
      .map(item => ({ ...item, id: item.id || crypto.randomUUID() }));
    imported.debts = Array.isArray(imported.debts) ? imported.debts : [];
    imported.wishlist = Array.isArray(imported.wishlist) ? imported.wishlist : [];
    imported.deleted = { transactions: [], categories: [], budgets: [], goals: [], debts: [], wishlist: [], ...(imported.deleted || {}) };
    data = mergeSpendData(data, { ...createStarterData(), ...imported });
    save();
    toast('Backup imported');
  } catch (error) {
    console.error('SpendWise backup import failed:', error);
    toast(error.message || 'Could not import this backup');
  } finally {
    event.target.value = '';
  }
};

modalBack.onclick = event => {
  if (event.target === modalBack && data.userName) closeModal();
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && data.userName) closeModal();
});
document.addEventListener('click', event => {
  if (!mobileNav.contains(event.target)) {
    mobileNav.classList.remove('menu-open');
    mobileNav.querySelector('[data-more]')?.setAttribute('aria-expanded', 'false');
  }
});
window.addEventListener('online', () => {
  if (cloudSession) scheduleCloudSync();
  else restoreServerSession();
});
window.addEventListener('resize', () => requestAnimationFrame(renderChart));
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredPrompt = event;
  installBtn.hidden = false;
});
installBtn.onclick = async () => {
  if (!deferredPrompt) {
    toast('Install is available from your browser menu');
    return;
  }
  await deferredPrompt.prompt();
  deferredPrompt = null;
  installBtn.hidden = true;
};

installThemeToggle();
updateAccountControls();
nav();
bindWishlistControls();
render();
showScreen('welcome');
document.body.classList.add('entry-mode');
restoreServerSession();
