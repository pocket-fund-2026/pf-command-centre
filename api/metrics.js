// Vercel Serverless Function: /api/metrics
// Returns productivity metrics from task history

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'pocket-fund-2026/pf-command-centre';
const TASKS_FILE = 'tasks.json';

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
      return [];
    }
    
    const data = await res.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString());
    return content.tasks || [];
  } catch (e) {
    console.error('Error getting tasks:', e);
    return [];
  }
}

// Helper: Get date range
function getDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { start, end };
}

// Helper: Check if date is in range
function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date >= start && date <= end;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const tasks = await getTasks();
  const { days = '7' } = req.query;
  const { start, end } = getDateRange(parseInt(days));
  
  // Filter completed tasks in range
  const completedTasks = tasks.filter(t => 
    t.status === 'done' && inRange(t.completedAt, start, end)
  );
  
  const failedTasks = tasks.filter(t => 
    t.status === 'failed' && inRange(t.completedAt, start, end)
  );
  
  // Tasks completed per assignee
  const byAssignee = {};
  for (const task of completedTasks) {
    const assignee = task.assignee || 'unassigned';
    if (!byAssignee[assignee]) {
      byAssignee[assignee] = {
        completed: 0,
        totalMinutes: 0,
        tasks: []
      };
    }
    byAssignee[assignee].completed++;
    if (task.actualMinutes) {
      byAssignee[assignee].totalMinutes += task.actualMinutes;
    }
    byAssignee[assignee].tasks.push({
      id: task.id,
      title: task.title || task.input,
      actualMinutes: task.actualMinutes
    });
  }
  
  // Calculate averages
  for (const assignee of Object.keys(byAssignee)) {
    const data = byAssignee[assignee];
    data.avgMinutes = data.completed > 0 
      ? Math.round(data.totalMinutes / data.completed) 
      : 0;
  }
  
  // Tasks by type
  const byType = {};
  for (const task of completedTasks) {
    const type = task.type || 'unknown';
    if (!byType[type]) {
      byType[type] = { completed: 0, avgMinutes: 0, totalMinutes: 0 };
    }
    byType[type].completed++;
    if (task.actualMinutes) {
      byType[type].totalMinutes += task.actualMinutes;
    }
  }
  for (const type of Object.keys(byType)) {
    byType[type].avgMinutes = byType[type].completed > 0
      ? Math.round(byType[type].totalMinutes / byType[type].completed)
      : 0;
  }
  
  // Daily breakdown
  const daily = {};
  for (const task of completedTasks) {
    const date = task.completedAt.split('T')[0];
    if (!daily[date]) {
      daily[date] = { completed: 0, failed: 0 };
    }
    daily[date].completed++;
  }
  for (const task of failedTasks) {
    const date = task.completedAt?.split('T')[0];
    if (date) {
      if (!daily[date]) {
        daily[date] = { completed: 0, failed: 0 };
      }
      daily[date].failed++;
    }
  }
  
  // Blocked time analysis
  const blockedTasks = tasks.filter(t => t.status === 'blocked');
  const blockedAnalysis = blockedTasks.map(t => {
    const blockedSince = t.updatedAt ? new Date(t.updatedAt) : new Date(t.createdAt);
    const hoursBlocked = Math.round((new Date() - blockedSince) / (1000 * 60 * 60));
    return {
      id: t.id,
      title: t.title || t.input,
      assignee: t.assignee,
      reason: t.blockedReason,
      hoursBlocked
    };
  });
  
  // Summary
  const summary = {
    period: `${days} days`,
    totalCompleted: completedTasks.length,
    totalFailed: failedTasks.length,
    successRate: completedTasks.length + failedTasks.length > 0
      ? Math.round((completedTasks.length / (completedTasks.length + failedTasks.length)) * 100)
      : 100,
    avgCompletionMinutes: completedTasks.length > 0
      ? Math.round(completedTasks.reduce((sum, t) => sum + (t.actualMinutes || 0), 0) / completedTasks.length)
      : 0,
    currentlyBlocked: blockedTasks.length,
    currentlyQueued: tasks.filter(t => t.status === 'queued').length,
    currentlyInProgress: tasks.filter(t => t.status === 'in_progress').length
  };
  
  return res.json({
    summary,
    byAssignee,
    byType,
    daily,
    blocked: blockedAnalysis
  });
}
