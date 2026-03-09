// Vercel Serverless Function: /api/tasks
// Handles task creation, listing, and bot wake-up

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'pocket-fund-2026/pf-command-centre';
const TASKS_FILE = 'tasks.json';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Helper: Get tasks.json from GitHub
async function getTasks() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${TASKS_FILE}`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    if (res.status === 404) {
      return { tasks: [], sha: null };
    }
    
    const data = await res.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString());
    return { tasks: content.tasks || [], sha: data.sha };
  } catch (e) {
    console.error('Error getting tasks:', e);
    return { tasks: [], sha: null };
  }
}

// Helper: Update tasks.json on GitHub
async function updateTasks(tasks, sha) {
  const content = Buffer.from(JSON.stringify({ tasks }, null, 2)).toString('base64');
  
  const body = {
    message: `Update tasks ${new Date().toISOString()}`,
    content,
  };
  
  if (sha) body.sha = sha;
  
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${TASKS_FILE}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  
  return res.ok;
}

// Helper: Send wake message to Telegram bot
async function wakeBot(taskId, assignee) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram credentials not set, skipping wake');
    return;
  }
  
  // Only wake bot for agent tasks, notify humans differently
  const isAgent = assignee?.startsWith('agent:');
  const message = isAgent 
    ? `[TASK:${taskId}] New task queued. Process it now.`
    : `[TASK:${taskId}] New task assigned to ${assignee}. Awaiting human action.`;
  
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    }
  );
}

// Generate task ID
function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

// Valid values
const VALID_TYPES = ['content', 'research', 'ops', 'deal'];
const VALID_PRIORITIES = ['p0', 'p1', 'p2'];
const VALID_STATUSES = ['queued', 'in_progress', 'blocked', 'review', 'done', 'failed'];

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // GET: Return current tasks (with optional filters)
  if (req.method === 'GET') {
    const { tasks } = await getTasks();
    const { status, assignee, type, priority } = req.query;
    
    let filtered = tasks;
    
    if (status) {
      filtered = filtered.filter(t => t.status === status);
    }
    if (assignee) {
      filtered = filtered.filter(t => t.assignee === assignee);
    }
    if (type) {
      filtered = filtered.filter(t => t.type === type);
    }
    if (priority) {
      filtered = filtered.filter(t => t.priority === priority);
    }
    
    return res.json({ tasks: filtered });
  }
  
  // POST: Create new task (extended schema)
  if (req.method === 'POST') {
    const { 
      title,
      type,
      assignee,
      priority,
      estimatedMinutes,
      // Legacy fields (backwards compatible)
      agent,
      subAgents,
      input 
    } = req.body;
    
    // Require either new schema (title + assignee) or legacy (agent + input)
    if (!title && !agent) {
      return res.status(400).json({ error: 'Missing title or agent' });
    }
    
    const { tasks, sha } = await getTasks();
    const now = new Date().toISOString();
    
    // Determine assignee from new field or legacy agent field
    const taskAssignee = assignee || (agent ? `agent:${agent}` : null);
    
    // Create task object (extended schema)
    const task = {
      id: generateId(),
      title: title || input,
      type: VALID_TYPES.includes(type) ? type : 'ops',
      assignee: taskAssignee,
      priority: VALID_PRIORITIES.includes(priority) ? priority : 'p1',
      status: 'queued',
      estimatedMinutes: estimatedMinutes || null,
      actualMinutes: null,
      createdBy: req.body.createdBy || 'api',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      blockedReason: null,
      output: null,
      // Legacy fields for agent tasks
      agent: agent || (assignee?.startsWith('agent:') ? assignee.replace('agent:', '') : null),
      subAgents: subAgents || [],
      input: input || title,
      progress: 0,
      currentStep: null,
      steps: (subAgents || []).map(name => ({
        name,
        status: 'pending',
        progress: 0
      })),
      error: null,
      updatedAt: now
    };
    
    // Add to queue
    tasks.unshift(task);
    
    // Keep only last 50 tasks
    if (tasks.length > 50) {
      tasks.splice(50);
    }
    
    // Save to GitHub
    const saved = await updateTasks(tasks, sha);
    
    if (!saved) {
      return res.status(500).json({ error: 'Failed to save task' });
    }
    
    // Wake the bot / notify
    await wakeBot(task.id, task.assignee);
    
    return res.status(201).json({ task });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
