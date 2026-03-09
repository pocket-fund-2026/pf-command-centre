// Vercel Serverless Function: /api/tasks/[id]
// Handles individual task operations: GET, PATCH, DELETE

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
async function updateTasks(tasks, sha, message) {
  const content = Buffer.from(JSON.stringify({ tasks }, null, 2)).toString('base64');
  
  const body = {
    message: message || `Update tasks ${new Date().toISOString()}`,
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

// Helper: Send notification to Telegram
async function notify(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return;
  }
  
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    }
  );
}

// Valid values
const VALID_STATUSES = ['queued', 'in_progress', 'blocked', 'review', 'done', 'failed'];
const VALID_PRIORITIES = ['p0', 'p1', 'p2'];

// Allowed PATCH fields
const PATCHABLE_FIELDS = [
  'status', 'progress', 'currentStep', 'output', 'error', 
  'blockedReason', 'actualMinutes', 'priority', 'assignee',
  'steps', 'startedAt', 'completedAt'
];

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const { id } = req.query;
  
  if (!id) {
    return res.status(400).json({ error: 'Missing task id' });
  }
  
  const { tasks, sha } = await getTasks();
  const taskIndex = tasks.findIndex(t => t.id === id);
  
  if (taskIndex === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  // GET: Return single task
  if (req.method === 'GET') {
    return res.json({ task: tasks[taskIndex] });
  }
  
  // PATCH: Update task fields
  if (req.method === 'PATCH') {
    const updates = req.body;
    const task = tasks[taskIndex];
    const now = new Date().toISOString();
    const oldStatus = task.status;
    
    // Apply allowed updates
    for (const field of PATCHABLE_FIELDS) {
      if (updates[field] !== undefined) {
        // Validate status
        if (field === 'status' && !VALID_STATUSES.includes(updates[field])) {
          return res.status(400).json({ error: `Invalid status: ${updates[field]}` });
        }
        // Validate priority
        if (field === 'priority' && !VALID_PRIORITIES.includes(updates[field])) {
          return res.status(400).json({ error: `Invalid priority: ${updates[field]}` });
        }
        task[field] = updates[field];
      }
    }
    
    // Auto-set timestamps based on status transitions
    if (updates.status) {
      if (updates.status === 'in_progress' && !task.startedAt) {
        task.startedAt = now;
      }
      if (['done', 'failed'].includes(updates.status) && !task.completedAt) {
        task.completedAt = now;
        // Calculate actual minutes if started
        if (task.startedAt) {
          const started = new Date(task.startedAt);
          const completed = new Date(now);
          task.actualMinutes = Math.round((completed - started) / 60000);
        }
      }
    }
    
    task.updatedAt = now;
    tasks[taskIndex] = task;
    
    // Save to GitHub
    const commitMsg = `Task ${id}: ${oldStatus} → ${task.status}`;
    const saved = await updateTasks(tasks, sha, commitMsg);
    
    if (!saved) {
      return res.status(500).json({ error: 'Failed to save task update' });
    }
    
    // Notify on significant status changes
    if (updates.status && updates.status !== oldStatus) {
      if (updates.status === 'done') {
        await notify(`✅ *Task completed:* ${task.title || task.input}\n_${task.assignee}_`);
      } else if (updates.status === 'blocked') {
        await notify(`🚫 *Task blocked:* ${task.title || task.input}\n_Reason: ${task.blockedReason || 'Not specified'}_`);
      } else if (updates.status === 'failed') {
        await notify(`❌ *Task failed:* ${task.title || task.input}\n_Error: ${task.error || 'Unknown'}_`);
      }
    }
    
    return res.json({ task });
  }
  
  // DELETE: Remove task
  if (req.method === 'DELETE') {
    const deletedTask = tasks.splice(taskIndex, 1)[0];
    
    const saved = await updateTasks(tasks, sha, `Delete task ${id}`);
    
    if (!saved) {
      return res.status(500).json({ error: 'Failed to delete task' });
    }
    
    return res.json({ deleted: true, task: deletedTask });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
