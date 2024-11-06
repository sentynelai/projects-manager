import express from 'express';
import session from 'express-session';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const CORRECT_PASSWORD = 'F3YZDmuG6Qk022MbihaN6rvQ4pnUUd';

// GitHub API configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_USERNAME = 'sentynelai';

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip') {
            cb(null, true);
        } else {
            cb(new Error('Only ZIP files are allowed'));
        }
    }
});

// Ensure uploads directory exists
if (!existsSync('uploads')) {
    await fs.mkdir('uploads');
}

// Configure session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
};

// GitHub API helper functions
async function githubRequest(endpoint, options = {}) {
    try {
        const url = `${GITHUB_API_URL}${endpoint}`;
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Node.js',
            ...(GITHUB_TOKEN && { 'Authorization': `token ${GITHUB_TOKEN}` }),
            ...options.headers
        };

        const response = await fetch(url, { ...options, headers });
        
        if (response.status === 403) {
            throw new Error('GitHub API rate limit exceeded. Please set GITHUB_TOKEN in .env file.');
        }
        
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.statusText}`);
        }
        
        return response.json();
    } catch (error) {
        console.error('GitHub API request failed:', error);
        throw error;
    }
}

async function getDefaultBranch(repoName) {
    const repoInfo = await githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}`);
    return repoInfo.default_branch;
}

async function createBlob(repoName, content) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
            content: content.toString('base64'),
            encoding: 'base64'
        })
    });
}

async function getReference(repoName, ref) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/ref/heads/${ref}`);
}

async function getCommit(repoName, commitSha) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/commits/${commitSha}`);
}

async function getTree(repoName, treeSha) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/trees/${treeSha}?recursive=1`);
}

async function createTree(repoName, baseTree, files) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
            base_tree: baseTree,
            tree: files
        })
    });
}

async function createCommit(repoName, message, treeSha, parentSha) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
            message,
            tree: treeSha,
            parents: [parentSha]
        })
    });
}

async function updateReference(repoName, ref, commitSha) {
    return githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}/git/refs/heads/${ref}`, {
        method: 'PATCH',
        body: JSON.stringify({
            sha: commitSha,
            force: true
        })
    });
}

async function updateRepository(repoName, zipPath, commitMessage) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-'));
    
    try {
        // Read the zip file and create AdmZip instance
        const zipBuffer = await fs.readFile(zipPath);
        const zip = new AdmZip(zipBuffer);
        
        // Extract ZIP contents
        zip.extractAllTo(tempDir, true);
        
        // Get repository default branch
        const defaultBranch = await getDefaultBranch(repoName);
        
        // Get current commit
        const ref = await getReference(repoName, defaultBranch);
        const commit = await getCommit(repoName, ref.object.sha);
        const tree = await getTree(repoName, commit.tree.sha);
        
        // Prepare new tree
        const newTree = [];
        const processedPaths = new Set();
        
        // Process files from ZIP
        async function processDirectory(dir, base = '') {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.join(base, entry.name);
                
                if (entry.isDirectory()) {
                    if (entry.name !== '.git') {
                        await processDirectory(fullPath, relativePath);
                    }
                } else {
                    const content = await fs.readFile(fullPath);
                    const blob = await createBlob(repoName, content);
                    
                    newTree.push({
                        path: relativePath.replace(/\\/g, '/'),
                        mode: '100644',
                        type: 'blob',
                        sha: blob.sha
                    });
                    
                    processedPaths.add(relativePath.replace(/\\/g, '/'));
                }
            }
        }
        
        // Get the first directory in tempDir (if ZIP had a single root dir)
        const tempContents = await fs.readdir(tempDir);
        const startDir = tempContents.length === 1 && (await fs.stat(path.join(tempDir, tempContents[0]))).isDirectory()
            ? path.join(tempDir, tempContents[0])
            : tempDir;
        
        await processDirectory(startDir);
        
        // Keep existing files that weren't in the ZIP
        for (const item of tree.tree) {
            if (!processedPaths.has(item.path) && item.type === 'blob' && !item.path.startsWith('.git/')) {
                newTree.push({
                    path: item.path,
                    mode: item.mode,
                    type: item.type,
                    sha: item.sha
                });
            }
        }
        
        // Create new tree and commit
        const createdTree = await createTree(repoName, null, newTree);
        const newCommit = await createCommit(repoName, commitMessage, createdTree.sha, ref.object.sha);
        await updateReference(repoName, defaultBranch, newCommit.sha);
        
        return true;
    } catch (error) {
        console.error('Error updating repository:', error);
        throw error;
    } finally {
        // Cleanup temp directory
        await fs.rm(tempDir, { recursive: true, force: true }).catch(console.error);
        // Cleanup uploaded file
        await fs.unlink(zipPath).catch(console.error);
    }
}

// Protected route to fetch GitHub repositories
app.get('/api/repos', requireAuth, async (req, res) => {
    try {
        const repos = await githubRequest(`/users/${GITHUB_USERNAME}/repos?per_page=100&sort=updated`);
        res.json(repos);
    } catch (error) {
        console.error('Error fetching repositories:', error);
        res.status(error.message.includes('rate limit') ? 403 : 500)
           .json({ 
               message: error.message || 'Error fetching repositories',
               needsToken: error.message.includes('rate limit')
           });
    }
});

app.post('/api/update-repo', requireAuth, upload.single('file'), async (req, res) => {
    if (!GITHUB_TOKEN) {
        return res.status(403).json({ 
            message: 'GitHub token not configured. Please set GITHUB_TOKEN in .env file.'
        });
    }

    try {
        const { changes, repoName } = req.body;
        const zipFile = req.file;

        if (!zipFile || !changes || !repoName) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        await updateRepository(repoName, zipFile.path, changes);

        res.json({ message: 'Repository updated successfully' });
    } catch (error) {
        console.error('Error updating repository:', error);
        res.status(500).json({ 
            message: 'Error updating repository',
            error: error.message 
        });
    }
});

// Routes
app.get('/', (req, res) => {
    if (req.session.authenticated) {
        res.redirect('/dashboard');
    } else {
        res.sendFile(join(__dirname, 'public', 'index.html'));
    }
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ success: false, message: 'Password is required' });
    }

    if (password === CORRECT_PASSWORD) {
        req.session.authenticated = true;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ success: false, message: 'Internal server error' });
            }
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destruction error:', err);
            return res.status(500).json({ success: false, message: 'Internal server error' });
        }
        res.json({ success: true });
    });
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(join(__dirname, 'public', 'dashboard.html'));
});

app.get('/project', requireAuth, (req, res) => {
    res.sendFile(join(__dirname, 'public', 'project.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});