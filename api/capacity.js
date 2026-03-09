// Vercel Serverless Function: /api/capacity
// Returns current capacity and load for all assignees

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'pocket-fund-2026/pf-command-centre';
const TASKS_FILE = 'tasks.json';

// Capacity limits
const CAPACITY = {
  // Agents: sequential (1 at a time)
  'agent:sage-reddit': 1,
  'agent:sage-shortform': 1,
  'agent:sage-linkedin': 1,
  'agent:sage-lens': 1,
  'agent:sage-twitter-ideator': 1,
  'agent:sage-vault': 1,
  'agent:sage-radar': 1,
  'agent:sage-validator': 1,
  'agent:deal-sourcing': 1,
  'agent:deal-analysis': 1,
  'agent:content-agent': 1,
  // Humans: can handle multiple
  'human:dev': 3,
  'human:harish': 3,
  'human:pushkar': 3,
  'human:aum': 3
};

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
  
  // Count active tasks per assignee
  const activeStatuses = ['in_progress', 'blocked', 'review'];
  const activeTasks = tasks.filter(t => activeStatuses.includes(t.status));
  
  const load = {};
  for (const task of activeTasks) {
    if (task.assignee) {
      load[task.assignee] = (load[task.assignee] || 0) + 1;
    }
  }
  
  // Build capacity report
  const capacity = [];
  
  for (const [assignee, maxConcurrent] of Object.entries(CAPACITY)) {
    const currentLoad = load[assignee] || 0;
    const available = maxConcurrent - currentLoad;
    const type = assignee.startsWith('agent:') ? 'agent' : 'human';
    
    capacity.push({
      assignee,
      type,
      maxConcurrent,
      currentLoad,
      available,
      status: available > 0 ? 'available' : 'busy'
    });
  }
  
  // Also include any assignees in tasks not in our predefined list
  for (const assignee of Object.keys(load)) {
    if (!CAPACITY[assignee]) {
      const type = assignee.startsWith('agent:') ? 'agent' : 'human';
      capacity.push({
        assignee,
        type,
        maxConcurrent: type === 'agent' ? 1 : 3,
        currentLoad: load[assignee],
        available: (type === 'agent' ? 1 : 3) - load[assignee],
        status: 'unknown'
      });
    }
  }
  
  // Sort: agents first, then humans; busy first
  capacity.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'agent' ? -1 : 1;
    if (a.status !== b.status) return a.status === 'busy' ? -1 : 1;
    return a.assignee.localeCompare(b.assignee);
  });
  
  // Summary stats
  const agents = capacity.filter(c => c.type === 'agent');
  const humans = capacity.filter(c => c.type === 'human');
  
  const summary = {
    totalTasks: tasks.length,
    activeTasks: activeTasks.length,
    queuedTasks: tasks.filter(t => t.status === 'queued').length,
    completedToday: tasks.filter(t => {
      if (t.status !== 'done' || !t.completedAt) return false;
      const completed = new Date(t.completedAt);
      const today = new Date();
      return completed.toDateString() === today.toDateString();
    }).length,
    agentsBusy: agents.filter(a => a.status === 'busy').length,
    agentsAvailable: agents.filter(a => a.status === 'available').length,
    humansBusy: humans.filter(h => h.currentLoad >= h.maxConcurrent).length,
    humansAvailable: humans.filter(h => h.currentLoad < h.maxConcurrent).length
  };
  
  return res.json({ capacity, summary });
}
