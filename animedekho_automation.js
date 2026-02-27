/**
 * AnimeDekho Auto-Scraper for Render/Railway Deployment
 * 
 * Runs bulk-export and optionally uploads SQL file to server via FTP
 * 
 * Usage:
 *   node animedekho_automation.js           # Run bulk export (default 50 anime)
 *   node animedekho_automation.js 0         # Export all anime
 *   node animedekho_automation.js 100       # Export 100 anime
 * 
 * Environment Variables:
 *   FTP_HOST         - FTP/SFTP server host
 *   FTP_PORT         - FTP port (default: 21)
 *   FTP_USER         - FTP username
 *   FTP_PASS         - FTP password
 *   FTP_PATH         - Remote path to upload (e.g., /public_html/animes/)
 *   EXPORT_LIMIT     - Default export limit (default: 50, 0 = all)
 *   SLACK_WEBHOOK    - Optional Slack webhook for notifications
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const EXPORT_LIMIT = parseInt(process.env.EXPORT_LIMIT || '0'); // Default: 0 = export all

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Generate filename with timestamp
function generateFilename() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `anime_batch_${timestamp}.sql`;
}

// Main export function
function runBulkExport(limit) {
    return new Promise((resolve, reject) => {
        const outputFile = path.join(OUTPUT_DIR, generateFilename());
        const writeStream = fs.createWriteStream(outputFile);
        
        console.log(`Starting bulk export (limit: ${limit === 0 ? 'all' : limit})...`);
        console.log(`Output file: ${outputFile}`);
        
        const importer = spawn('node', ['animedekho_importer.js', 'bulk-export', limit.toString()], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderrOutput = '';
        
        importer.stdout.on('data', (data) => {
            writeStream.write(data.toString());
        });

        importer.stderr.on('data', (data) => {
            const msg = data.toString();
            stderrOutput += msg;
            // Show progress to console
            if (msg.includes('Exporting:') || msg.includes('-> S') || msg.includes('COMPLETE') || msg.includes('Found')) {
                console.log(msg.trim());
            }
        });

        importer.on('close', (code) => {
            writeStream.end(() => {
                if (code === 0) {
                    console.log(`\n✓ Export completed: ${outputFile}`);
                    resolve({ success: true, file: outputFile, stats: stderrOutput });
                } else {
                    console.error(`\n✗ Export failed with code ${code}`);
                    reject(new Error(`Export process exited with code ${code}`));
                }
            });
        });

        importer.on('error', (err) => {
            reject(err);
        });
    });
}

// FTP Upload function
async function uploadToFTP(localFile) {
    const FTP = require('ftp');
    
    const config = {
        host: process.env.FTP_HOST,
        port: parseInt(process.env.FTP_PORT || '21'),
        user: process.env.FTP_USER,
        password: process.env.FTP_PASS
    };

    if (!config.host || !config.user || !config.password) {
        console.log('⚠ FTP not configured, skipping upload');
        return null;
    }

    return new Promise((resolve, reject) => {
        const ftp = new FTP();
        
        ftp.connect(config, () => {
            console.log('✓ Connected to FTP server');
            
            const remotePath = process.env.FTP_PATH || '/';
            const filename = path.basename(localFile);
            const fullRemotePath = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
            
            console.log(`Uploading to: ${fullRemotePath}`);
            
            ftp.put(localFile, fullRemotePath, (err) => {
                if (err) {
                    ftp.end();
                    reject(err);
                    return;
                }
                
                console.log('✓ Upload complete');
                ftp.end();
                resolve(fullRemotePath);
            });
        });

        ftp.on('error', reject);
    });
}

// Send Slack notification
async function sendSlackNotification(result) {
    const webhookUrl = process.env.SLACK_WEBHOOK;
    if (!webhookUrl) return;

    const fileInfo = fs.statSync(result.file);
    const fileSizeMB = (fileInfo.size / (1024 * 1024)).toFixed(2);
    
    const message = {
        text: `🎬 Anime Scraper Completed`,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*AnimeDekho Bulk Export Complete*\n\n📁 File: ${path.basename(result.file)}\n📊 Size: ${fileSizeMB} MB\n✅ Status: Success`
                }
            }
        ]
    };

    try {
        const https = require('https');
        const req = https.request(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            console.log('✓ Slack notification sent');
        });
        
        req.write(JSON.stringify(message));
        req.end();
    } catch (e) {
        console.log('⚠ Slack notification failed:', e.message);
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    let limit = args[0] ? parseInt(args[0]) : EXPORT_LIMIT;
    
    // Default to all (0) if not specified
    if (!args[0] && EXPORT_LIMIT === 0) {
        limit = 0;
    }
    
    console.log('========================================');
    console.log('  AnimeDekho Auto-Scraper');
    console.log('========================================');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Limit: ${limit === 0 ? 'all' : limit}`);
    console.log('----------------------------------------\n');
    
    try {
        // Run the export
        const result = await runBulkExport(limit);
        
        // Upload to FTP if configured
        if (process.env.FTP_HOST) {
            try {
                const uploadPath = await uploadToFTP(result.file);
                if (uploadPath) {
                    console.log(`📤 Uploaded to: ${uploadPath}`);
                }
            } catch (uploadErr) {
                console.error('✗ Upload failed:', uploadErr.message);
            }
        }
        
        // Send notification
        await sendSlackNotification(result);
        
        console.log('\n========================================');
        console.log('  ✓ All tasks completed successfully');
        console.log('========================================');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n========================================');
        console.error('  ✗ Error:', error.message);
        console.error('========================================');
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { runBulkExport, uploadToFTP };
