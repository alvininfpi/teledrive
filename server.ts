import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import multer from 'multer';
import { Api } from 'telegram/tl';
import crypto from 'crypto';
import fs from 'fs';
import { CustomFile } from 'telegram/client/uploads';
import archiver from 'archiver';
import axios from 'axios';
import { Readable } from 'stream';


const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Configuration from env
const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
const apiHash = process.env.TELEGRAM_API_HASH || '';
const stringSession = new StringSession(process.env.TELEGRAM_STRING_SESSION || '');
const chatIdStr = process.env.TELEGRAM_CHAT_ID || 'me';
const chatId = /^-?\d+$/.test(chatIdStr) ? Number(chatIdStr) : chatIdStr;
const appPassword = process.env.APP_PASSWORD || '';

// Set up multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

let client: TelegramClient;

async function initTelegram() {
  if (client && client.connected) {
    return client;
  }

  if (!apiId || !apiHash) {
    console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env');
    return;
  }
  
  if (!client) {
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: true, // often better for web environments
    });
  }

  try {
    await client.connect();
    console.log('Connected to Telegram');
    // If not authorized, you need to provide string session in env
    if (!await client.isUserAuthorized()) {
      console.warn('TELEGRAM USER NOT AUTHORIZED. Please provide a valid TELEGRAM_STRING_SESSION.');
    }
  } catch (err: any) {
    if (err.message.includes('AUTH_KEY_DUPLICATED')) {
      console.error('ERROR: AUTH_KEY_DUPLICATED detected. This session string is already being used by another active connection.');
      console.error('Please stop other instances (like your local dev server) or generate a new session string for this deployment.');
    } else {
      console.error('Failed to connect to Telegram:', err);
    }
  }
  return client;
}

async function startServer() {
  await initTelegram();

  app.use(express.json());

  // App Password Middleware
  app.use((req, res, next) => {
    if (!appPassword) return next();
    
    // allow download without password for public links
    if (req.path.startsWith('/api/download/')) return next();
    if (req.path.startsWith('/api/download-folder')) {
      const providedPass = req.headers['x-app-password'] || req.query.app_password;
      if (appPassword && providedPass !== appPassword) {
        return res.status(401).json({ error: 'Invalid config' });
      }
      return next();
    }
    if (req.path === '/api/auth/status') return next();
    
    if (req.path.startsWith('/api/')) {
      const providedPass = req.headers['x-app-password'] || req.query.app_password;
      if (providedPass !== appPassword) {
        return res.status(401).json({ error: 'Invalid or missing App Password' });
      }
    }
    next();
  });

  // API: Get List of Files
  app.get('/api/files', async (req, res) => {
    try {
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      const messages = await client.getMessages(chatId, { limit: 10000 });
      const files = messages
        .filter(m => m.media && (m.media.className === 'MessageMediaDocument'))
        .map(m => {
          const doc = (m.media as any).document as Api.Document;
          // Find filename in attributes
          const filenameAttr = doc.attributes.find(a => a.className === 'DocumentAttributeFilename') as Api.DocumentAttributeFilename;
          let folder = '/';
          if (m.message && m.message.startsWith('FOLDER:')) {
            folder = m.message.substring(7);
          }
          const name = filenameAttr ? filenameAttr.fileName : 'unnamed_file';
          
          return {
            id: m.id,
            date: m.date,
            size: doc.size.toString(),
            name,
            mimeType: doc.mimeType,
            folder,
            isPlaceholder: name === '.folder'
          };
        });

      res.json(files);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch files' });
    }
  });

  // Store upload state
  const uploadStateMap = new Map<string, { fileId: any }>();

  // API: Delete Files
  app.post('/api/delete', async (req, res) => {
    try {
      const { ids } = req.body;
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      if (ids && Array.isArray(ids) && ids.length > 0) {
        await client.deleteMessages(chatId, ids, { revoke: true });
      }
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Create Folder
  app.post('/api/folders/create', async (req, res) => {
    try {
      const { path, name } = req.body;
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      // We create a folder by uploading a dummy ".folder" file
      const dummyBuffer = Buffer.from('TeleDrive Private Folder');
      const dummyFile = new CustomFile('.folder', dummyBuffer.length, '', dummyBuffer);
      const folderPath = path === '/' ? name : `${path}/${name}`;

      await client.sendFile(chatId, {
        file: dummyFile,
        caption: `FOLDER:${folderPath}`,
        forceDocument: true,
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: '.folder' })
        ]
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('Create folder error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Chunk Upload
  app.post('/api/upload/chunk', upload.single('chunk'), async (req, res) => {
    try {
      const { uploadId, chunkIndex, totalChunks, totalSize } = req.body;
      if (!req.file) return res.status(400).json({ error: 'No chunk provided' });
      if (!client || !(await client.isUserAuthorized())) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      let state = uploadStateMap.get(uploadId);
      if (!state) {
        // Generate random 64-bit ID
        const randBuffer = crypto.randomBytes(8);
        const fileId = randBuffer.readBigInt64LE();
        state = { fileId };
        uploadStateMap.set(uploadId, state);
      }
      
      const chunkBuffer = req.file.buffer;
      const isLarge = Number(totalSize) > 10 * 1024 * 1024;

      if (isLarge) {
        await client.invoke(new Api.upload.SaveBigFilePart({
          fileId: state.fileId,
          filePart: Number(chunkIndex),
          fileTotalParts: Number(totalChunks),
          bytes: chunkBuffer
        }));
      } else {
        await client.invoke(new Api.upload.SaveFilePart({
          fileId: state.fileId,
          filePart: Number(chunkIndex),
          bytes: chunkBuffer
        }));
      }

      res.json({ success: true });
    } catch (err: any) {
      console.error('Chunk upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Complete Chunked Upload
  app.post('/api/upload/complete', async (req, res) => {
    try {
      const { uploadId, totalChunks, totalSize, filename, folder } = req.body;
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      const state = uploadStateMap.get(uploadId);
      if (!state) {
        return res.status(400).json({ error: 'Upload ID not found or already completed' });
      }

      console.log(`Finalizing file ${filename} (ID: ${uploadId}) directly to Telegram...`);
      const isLarge = Number(totalSize) > 10 * 1024 * 1024;
      
      const inputFile = isLarge 
        ? new Api.InputFileBig({
            id: state.fileId,
            parts: Number(totalChunks),
            name: filename
          })
        : new Api.InputFile({
            id: state.fileId,
            parts: Number(totalChunks),
            name: filename,
            md5Checksum: ""
          });

      const captionText = folder ? `FOLDER:${folder}` : `Uploaded via TeleDrive: ${filename}`;

      await client.sendFile(chatId, {
        file: inputFile,
        caption: captionText,
        forceDocument: true,
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: filename })
        ]
      });

      uploadStateMap.delete(uploadId);
      res.json({ success: true, message: 'File uploaded to Telegram' });

    } catch (err: any) {
      console.error('Upload complete Error:', err);
      const { uploadId } = req.body;
      uploadStateMap.delete(uploadId);
      res.status(500).json({ error: 'Upload failed: ' + (err.message || 'Unknown error') });
    }
  });

  const urlUploadStates = new Map<string, { progress: number, status: 'downloading' | 'uploading' | 'completed' | 'failed', error?: string }>();

  app.post('/api/upload/url/start', async (req, res) => {
    try {
      const { url, folder } = req.body;
      if (!url) return res.status(400).json({ error: 'URL is required' });
      
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      const uploadId = Date.now().toString() + '_' + Math.random().toString(36).substring(2, 9);
      urlUploadStates.set(uploadId, { progress: 0, status: 'downloading' });

      res.json({ uploadId });

      // Run in background
      (async () => {
        const tmpDir = process.env.TMPDIR || '/tmp';
        const tempFilePath = path.join(tmpDir, `url-dl-${uploadId}`);

        try {
          console.log(`Downloading from URL: ${url}`);
          
          const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
          });

          let filename = 'downloaded_file';
          const contentDisposition = response.headers['content-disposition'];
          if (contentDisposition) {
            const match = contentDisposition.match(/filename="?([^"]+)"?/);
            if (match && match[1]) {
              filename = match[1];
            }
          } else {
            try {
              const urlObj = new URL(url);
              const urlPath = urlObj.pathname.split('/').pop();
              if (urlPath) filename = urlPath;
            } catch (e) {
              // ignore
            }
          }

          const totalLength = parseInt(response.headers['content-length'] || '0', 10);
          let downloaded = 0;

          const writer = fs.createWriteStream(tempFilePath);
          
          response.data.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (totalLength > 0) {
              const percent = Math.round((downloaded / totalLength) * 50); // 0-50%
              urlUploadStates.set(uploadId, { progress: percent, status: 'downloading' });
            }
          });

          response.data.pipe(writer);

          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          const fileStat = fs.statSync(tempFilePath);
          const customFile = new CustomFile(filename, fileStat.size, tempFilePath);

          urlUploadStates.set(uploadId, { progress: 50, status: 'uploading' });

          const toUpload = await client.uploadFile({
            file: customFile,
            workers: 1,
            onProgress: (progress: number) => {
              const percent = 50 + Math.round(progress * 50); // 50-100%
              urlUploadStates.set(uploadId, { progress: percent, status: 'uploading' });
            }
          });

          const captionText = folder ? `FOLDER:${folder}` : `Uploaded via TeleDrive: ${filename}`;

          await client.sendFile(chatId, {
            file: toUpload,
            caption: captionText,
            forceDocument: true,
            attributes: [
              new Api.DocumentAttributeFilename({ fileName: filename })
            ]
          });

          urlUploadStates.set(uploadId, { progress: 100, status: 'completed' });
          fs.unlinkSync(tempFilePath);

        } catch (err: any) {
          console.error(`URL upload error for ${uploadId}:`, err);
          urlUploadStates.set(uploadId, { progress: 0, status: 'failed', error: err.message });
          if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
          }
        }
      })();

    } catch (err: any) {
      console.error('URL start error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/upload/url/status', (req, res) => {
    const { uploadId } = req.query;
    if (!uploadId || typeof uploadId !== 'string') {
      return res.status(400).json({ error: 'uploadId is required' });
    }
    const state = urlUploadStates.get(uploadId);
    if (!state) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    res.json(state);
  });

  // Old API: Upload File (kept for fallback)
  app.post('/api/upload', upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      console.log(`Uploading ${req.file.originalname} to Telegram...`);
      
      const fileStat = fs.statSync(req.file.path);
      const customFile = new CustomFile(req.file.originalname, fileStat.size, req.file.path);

      const toUpload = await client.uploadFile({
        file: customFile,
        workers: 1,
      });

      await client.sendFile(chatId, {
        file: toUpload,
        caption: `Uploaded via TeleDrive: ${req.file.originalname}`,
        forceDocument: true,
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: req.file.originalname })
        ]
      });

      // Cleanup local file
      fs.unlinkSync(req.file.path);

      res.json({ success: true, message: 'File uploaded to Telegram' });
    } catch (err: any) {
      console.error('Upload Error:', err);
      // Attempt cleanup if failed
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      res.status(500).json({ error: 'Upload failed: ' + (err.message || 'Unknown error') });
    }
  });

  // API: Download Folder
  app.get('/api/download-folder', async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    try {
      const folderPath = req.query.path as string;
      if (!folderPath) {
        return res.status(400).json({ error: 'Folder path is required' });
      }
      
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      const messages = await client.getMessages(chatId, { limit: 10000 });
      const filesInFolder = [];
      
      // Normalize folderPath
      let normPath = folderPath || '/';
      if (!normPath.startsWith('/')) normPath = '/' + normPath;
      const normPathNoSlash = normPath === '/' ? '/' : normPath.replace(/\/$/, '');

      for (const m of messages) {
         if (m.media && m.media.className === 'MessageMediaDocument') {
            const doc = m.media.document as Api.Document;
            let fFolder = '/';
            if (m.message && m.message.startsWith('FOLDER:')) {
              fFolder = m.message.substring(7);
            }
            if (!fFolder.startsWith('/')) fFolder = '/' + fFolder;
            const normFFolder = fFolder === '/' ? '/' : fFolder.replace(/\/$/, '');
            
            if (normFFolder === normPathNoSlash || normFFolder.startsWith(normPathNoSlash === '/' ? '/' : normPathNoSlash + '/')) {
               const filenameAttr = doc.attributes.find(a => a.className === 'DocumentAttributeFilename') as Api.DocumentAttributeFilename;
               const name = filenameAttr ? filenameAttr.fileName : 'unnamed_file';
               
               filesInFolder.push({
                 id: m.id,
                 name,
                 folder: fFolder,
                 message: m,
                 doc,
                 isDir: name === '.folder'
               });
            }
         }
      }

      const folderName = normPathNoSlash === '/' ? 'My_Drive' : normPathNoSlash.split('/').pop() || 'folder';
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);

      const archive = archiver('zip', {
        zlib: { level: 0 } // Fast packaging, files are likely already compressed or media
      });

      archive.on('error', (err) => {
        console.error('Archiver error:', err);
      });

      archive.pipe(res);
      
      let itemsAppended = 0;

      for (const file of filesInFolder) {
        let subFolderPath = '';
        if (normPathNoSlash !== '/') {
           if (file.folder !== normPathNoSlash && file.folder.startsWith(normPathNoSlash + '/')) {
             subFolderPath = file.folder.substring(normPathNoSlash.length + 1) + '/';
           }
        } else {
           if (file.folder !== '/') {
             subFolderPath = file.folder.substring(1) + '/';
           }
        }

        if (file.isDir) {
           if (subFolderPath) {
             archive.append('', { name: subFolderPath }); 
             itemsAppended++;
           }
           continue; 
        }

        const iter = client.iterDownload({
          file: file.message.media,
          requestSize: 1024 * 1024, // 1MB chunks
        });

        // Convert async iterable to Readable stream
        const stream = Readable.from(iter);
        
        archive.append(stream, { name: `${subFolderPath}${file.name}` });
        itemsAppended++;
      }
      
      if (itemsAppended === 0) {
        archive.append('This folder is empty.', { name: '.empty' });
      }

      await archive.finalize();

    } catch (err: any) {
      console.error('Download folder error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // API: Download File
  app.get('/api/download/:msgId', async (req, res) => {
    req.setTimeout(0);
    res.setTimeout(0);
    try {
      if (!client || !await client.isUserAuthorized()) {
        return res.status(401).json({ error: 'Telegram not authorized' });
      }

      const msgId = parseInt(req.params.msgId);
      const messages = await client.getMessages(chatId, { ids: [msgId] });
      const message = messages[0];

      if (!message || !message.media) {
        return res.status(404).json({ error: 'File not found' });
      }

      let filename = 'download';
      let mimeType = 'application/octet-stream';
      let size: number | undefined;

      if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
        const doc = message.media.document;
        const filenameAttr = doc.attributes?.find(a => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename;
        if (filenameAttr && filenameAttr.fileName) {
          filename = filenameAttr.fileName;
        }
        mimeType = doc.mimeType || 'application/octet-stream';
        size = doc.size ? Number(doc.size) : undefined;
      } else if (message.media instanceof Api.MessageMediaPhoto) {
        filename = `photo_${msgId}.jpg`;
        mimeType = 'image/jpeg';
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', mimeType);
      if (size) {
        res.setHeader('Content-Length', size.toString());
      }

      const iter = client.iterDownload({
        file: message.media,
        requestSize: 1024 * 1024,
      });

      for await (const chunk of iter) {
        const canWrite = res.write(chunk);
        if (!canWrite) {
          await new Promise<void>((resolve) => {
            res.once('drain', resolve);
          });
        }
      }
      res.end();
    } catch (err: any) {
      console.error('Download stream error:', err);
      // If headers are already sent, we shouldn't send JSON. 
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed: ' + err.message });
      } else {
        res.end();
      }
    }
  });

  // API: Auth Status
  app.get('/api/auth/status', async (req, res) => {
    let requiresAppPassword = false;
    let appPasswordValid = true;

    if (appPassword) {
      requiresAppPassword = true;
      if (req.headers['x-app-password'] !== appPassword) {
        appPasswordValid = false;
      }
    }

    const isAuthorized = client ? await client.isUserAuthorized() : false;
    res.json({ 
      isAuthorized, 
      apiConfigured: !!(apiId && apiHash),
      chatId,
      requiresAppPassword,
      appPasswordValid
    });
  });

  // Store temporary login state in memory
  let phoneCodeHash: string | undefined;
  let tempClient: TelegramClient | undefined;

  // API: Send Code
  app.post('/api/auth/send-code', async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!apiId || !apiHash) return res.status(400).json({ error: 'API_ID/HASH not set' });
      
      // Create a temporary client for login
      tempClient = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
      await tempClient.connect();
      
      const result = await tempClient.sendCode({ apiId, apiHash }, phoneNumber);
      phoneCodeHash = result.phoneCodeHash;
      
      res.json({ success: true, message: 'Code sent to your Telegram app' });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Sign In
  app.post('/api/auth/signin', async (req, res) => {
    try {
      const { phoneNumber, code, password } = req.body;
      if (!tempClient || !phoneCodeHash) return res.status(400).json({ error: 'No login in progress' });

      await tempClient.start({
        phoneNumber: () => Promise.resolve(phoneNumber),
        phoneCode: () => Promise.resolve(code),
        password: () => Promise.resolve(password || ''), // Optional 2FA
        onError: (err) => { throw err; }
      });

      const newSession = (tempClient.session as StringSession).save();
      console.log('NEW STRING SESSION GENERATED:', newSession);
      
      // Update global client
      client = tempClient; 
      
      res.json({ success: true, session: newSession, message: 'Successfully logged in!' });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Restore Session
  app.post('/api/auth/restore', async (req, res) => {
    try {
      const { session } = req.body;
      if (!session) return res.status(400).json({ error: 'No session provided' });
      
      const newStringSession = new StringSession(session);
      const newClient = new TelegramClient(newStringSession, apiId, apiHash, { connectionRetries: 5 });
      await newClient.connect();
      
      if (await newClient.isUserAuthorized()) {
        client = newClient;
        res.json({ success: true, authorized: true });
      } else {
        res.json({ success: false, authorized: false });
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Serve Frontend
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const host = process.env.IP || '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`Server running on http://${host}:${PORT}`);
  });
}

startServer();
