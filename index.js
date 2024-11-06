import express from 'express';
import session from 'express-session';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

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

// GitHub API helper function
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

// Protected route to fetch GitHub repositories
app.get('/api/repos', requireAuth, async (req, res) => {
    try {
        // First try to fetch public repositories without authentication
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

// Rest of your routes...
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

app.post('/api/update-repo', requireAuth, upload.single('file'), async (req, res) => {
    if (!GITHUB_TOKEN) {
        return res.status(403).json({ 
            message: 'GitHub token not configured. Please set GITHUB_TOKEN in .env file.'
        });
    }

    try {
        const { changes, repoName, repoUrl } = req.body;
        const zipFile = req.file;

        if (!zipFile || !changes || !repoName || !repoUrl) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const zip = new AdmZip(zipFile.path);
        const extractPath = join('uploads', `${repoName}-${Date.now()}`);
        zip.extractAllTo(extractPath, true);

        try {
            await githubRequest(`/repos/${GITHUB_USERNAME}/${repoName}`);

            res.json({ 
                message: 'Changes received and validated',
                status: 'GitHub integration ready for implementation'
            });
        } catch (error) {
            console.error('GitHub API error:', error);
            res.status(500).json({ 
                message: 'Error accessing GitHub repository',
                error: error.message 
            });
        } finally {
            await fs.unlink(zipFile.path);
            await fs.rm(extractPath, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Error processing repository update:', error);
        res.status(500).json({ message: 'Error processing repository update' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});