// Vercel Serverless Function: /api/tasks
// Handles task creation, status polling, and bot wake-up

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
async function wakeBot(taskId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram credentials not set, skipping wake');
    return;
  }
  
  const message = `[TASK:${taskId}] New task queued. Process it now.`;
  
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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // GET: Return current tasks
  if (req.method === 'GET') {
    const { tasks } = await getTasks();
    return res.json({ tasks });
  }
  
  // POST: Create new task
  if (req.method === 'POST') {
    const { agent, subAgents, input } = req.body;
    
    if (!agent || !input) {
      return res.status(400).json({ error: 'Missing agent or input' });
    }
    
    const { tasks, sha } = await getTasks();
    
    // Create task object
    const task = {
      id: generateId(),
      agent,
      subAgents: subAgents || [],
      input,
      status: 'queued',
      progress: 0,
      currentStep: null,
      steps: (subAgents || []).map(name => ({
        name,
        status: 'pending',
        progress: 0
      })),
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Add to queue
    tasks.unshift(task);
    
    // Keep only last 20 tasks
    if (tasks.length > 20) {
      tasks.splice(20);
    }
    
    // Save to GitHub
    const saved = await updateTasks(tasks, sha);
    
    if (!saved) {
      return res.status(500).json({ error: 'Failed to save task' });
    }
    
    // Wake the bot
    await wakeBot(task.id);
    
    return res.json({ task });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
