/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  File as FileIcon, 
  Download, 
  Cloud, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  Trash2, 
  FileText, 
  Image as ImageIcon,
  MoreVertical,
  Search,
  Plus,
  FolderPlus,
  ChevronRight,
  Settings,
  Grid,
  ChevronDown,
  X,
  Minimize2,
  Maximize2,
  FolderUp,
  Link2,
  Share2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface TelegramFile {
  id: number;
  name: string;
  size: string;
  date: number;
  mimeType?: string;
  folder?: string;
  isPlaceholder?: boolean;
}

interface AuthStatus {
  isAuthorized: boolean;
  apiConfigured: boolean;
  chatId: string;
  requiresAppPassword?: boolean;
  appPasswordValid?: boolean;
}

interface QueuedUpload {
  file: File;
  path: string;
  id: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed' | 'canceled';
  progress: number;
}

export default function App() {
  const [files, setFiles] = useState<TelegramFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeUploads, setActiveUploads] = useState<QueuedUpload[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentFolder, setCurrentFolder] = useState('/');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const [loginStep, setLoginStep] = useState<'phone' | 'code'>('phone');
  const [appPasswordInput, setAppPasswordInput] = useState('');
  const [appPassword, setAppPassword] = useState(localStorage.getItem('app_password') || '');
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [isUploadManagerOpen, setIsUploadManagerOpen] = useState(true);
  const [isUploadManagerMinimized, setIsUploadManagerMinimized] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [itemToDelete, setItemToDelete] = useState<any>(null);

  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});

  const getItemId = (f: TelegramFile | { isFolder: true; name: string }) => 'isFolder' in f ? 'folder:' + f.name : 'file:' + f.id;

  const toggleSelection = (id: string) => {
      setSelectedItems(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
      });
  };

  const handleBatchDelete = async () => {
      if (!window.confirm(`Are you sure you want to delete ${selectedItems.size} item(s)?`)) return;
      let idsToDelete: number[] = [];
      const arraySelected = Array.from(selectedItems);
      
      arraySelected.forEach(idStr => {
          if (idStr.startsWith('folder:')) {
              const folderName = idStr.substring(7);
              const folderPath = currentFolder === '/' ? '/' + folderName : currentFolder + (currentFolder.endsWith('/') ? '' : '/') + folderName;
              
              files.forEach(f => {
                let fFolder = f.folder || '/';
                if (!fFolder.startsWith('/')) fFolder = '/' + fFolder;
                if (fFolder === folderPath || fFolder.startsWith(folderPath + '/')) {
                  idsToDelete.push(f.id);
                }
              });
          } else {
              idsToDelete.push(parseInt(idStr.substring(5)));
          }
      });

      try {
        setLoading(true);
        const res = await fetch('/api/delete', {
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ids: idsToDelete })
        });
        if (res.ok) {
            fetchFiles();
            setSelectedItems(new Set());
        } else {
            alert('Batch delete failed');
        }
      } catch (e) {
          alert('Batch delete failed');
      } finally {
          setLoading(false);
      }
  };

  const handleBatchDownload = () => {
      const arraySelected = Array.from(selectedItems);
      let delay = 0;
      arraySelected.forEach(idStr => {
          setTimeout(() => {
              if (idStr.startsWith('folder:')) {
                  const folderName = idStr.substring(7);
                  const folderPath = currentFolder === '/' ? '/' + folderName : currentFolder + '/' + folderName;
                  triggerDownload(`/api/download-folder?path=${encodeURIComponent(folderPath)}`, folderName + '.zip');
              } else {
                  const fileStr = idStr.substring(5);
                  const f = files.find(f => f.id.toString() === fileStr);
                  triggerDownload(`/api/download/${fileStr}`, f ? f.name : 'download');
              }
          }, delay);
          delay += 500; // stagger downloads slightly to avoid browser blocking
      });
      setSelectedItems(new Set());
  };

  useEffect(() => {
    const pending = activeUploads.filter(u => u.status === 'pending');
    const uploading = activeUploads.find(u => u.status === 'uploading');

    if (pending.length > 0 && !uploading) {
        startNextUpload(pending[0]);
    }
  }, [activeUploads]);

  const cancelUpload = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (abortControllers.current[id]) {
        abortControllers.current[id].abort();
        delete abortControllers.current[id];
    }
    setActiveUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'canceled' } : u));
  };

  const startNextUpload = async (upload: QueuedUpload) => {
    setActiveUploads(prev => prev.map(u => u.id === upload.id ? { ...u, status: 'uploading' } : u));
    
    const { file, path, id } = upload;
    const CHUNK_SIZE = 512 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadIdSrc = id;

    const abortController = new AbortController();
    abortControllers.current[id] = abortController;

    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk);
        formData.append('uploadId', uploadIdSrc);
        formData.append('chunkIndex', i.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('totalSize', file.size.toString());
        
        const res = await fetch('/api/upload/chunk', {
          method: 'POST',
          headers: getHeaders(),
          body: formData,
          signal: abortController.signal
        });

        if (!res.ok) throw new Error('Failed to upload chunk ' + i);

        const progress = Math.round(((i + 1) / totalChunks) * 99);
        setActiveUploads(prev => prev.map(u => u.id === id ? { ...u, progress } : u));
      }

      const completeRes = await fetch('/api/upload/complete', {
         method: 'POST',
         headers: getHeaders({ 'Content-Type': 'application/json' }),
         body: JSON.stringify({
            uploadId: uploadIdSrc,
            totalChunks,
            totalSize: file.size,
            filename: file.name,
            folder: path !== '/' ? path : ''
         }),
         signal: abortController.signal
      });

      if (completeRes.ok) {
        setActiveUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'completed', progress: 100 } : u));
        fetchFiles(false);
      } else {
        throw new Error('Completion failed');
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setActiveUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'failed' } : u));
    } finally {
      delete abortControllers.current[id];
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const newItems = Array.from(files).map(file => ({
      file,
      path: currentFolder,
      id: Date.now().toString() + '_' + Math.random().toString(36).substring(2, 9),
      status: 'pending' as const,
      progress: 0
    }));

    setActiveUploads(prev => [...prev, ...newItems]);
    setIsUploadManagerOpen(true);
    setIsUploadManagerMinimized(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setShowNewMenu(false);
  };

  const handleFolderUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const newItems = Array.from(files).map(file => {
      const relativePath = (file as any).webkitRelativePath;
      const pathParts = relativePath.split('/');
      pathParts.pop();
      const subFolder = pathParts.join('/');
      let fullPath = currentFolder;
      if (subFolder) {
        fullPath = currentFolder === '/' 
          ? '/' + subFolder 
          : currentFolder + (currentFolder.endsWith('/') ? '' : '/') + subFolder;
      }
      return {
        file,
        path: fullPath,
        id: Date.now().toString() + '_' + Math.random().toString(36).substring(2, 9),
        status: 'pending' as const,
        progress: 0
      };
    });

    setActiveUploads(prev => [...prev, ...newItems]);
    setIsUploadManagerOpen(true);
    setIsUploadManagerMinimized(false);
    if (folderInputRef.current) folderInputRef.current.value = '';
    setShowNewMenu(false);
  };

  useEffect(() => {
    if (appPassword) {
      localStorage.setItem('app_password', appPassword);
      fetchAuthStatus();
      fetchFiles();
    }
  }, [appPassword]);

  useEffect(() => {
    const savedSession = localStorage.getItem('telegram_session');
    if (savedSession) {
      restoreSession(savedSession);
    } else {
      fetchAuthStatus();
      fetchFiles();
    }
  }, []);

  const getHeaders = (base: Record<string, string> = {}) => {
    return appPassword ? { ...base, 'x-app-password': appPassword } : base;
  };

  const restoreSession = async (session: string) => {
    try {
      const res = await fetch('/api/auth/restore', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ session })
      });
      fetchAuthStatus();
      fetchFiles();
    } catch (e) {
      fetchAuthStatus();
    }
  };

  const fetchAuthStatus = async () => {
    try {
      const res = await fetch('/api/auth/status', { headers: getHeaders() });
      const data = await res.json();
      setAuthStatus(data);
      if (!data.isAuthorized && (!data.requiresAppPassword || data.appPasswordValid)) setShowLogin(true);
    } catch (err) {
      console.error('Failed to fetch auth status', err);
    }
  };

  const fetchFiles = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/files', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setFiles(data);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const handleCreateFolder = () => {
    setShowNewMenu(false);
    setNewFolderName('');
    setShowCreateFolderModal(true);
  };

  const confirmCreateFolder = async () => {
    const cleanName = newFolderName.replace(/[\/\\]/g, '').trim();
    if (!cleanName) return;

    try {
        setLoading(true);
        const res = await fetch('/api/folders/create', {
            method: 'POST',
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: currentFolder, name: cleanName })
        });
        if (res.ok) {
            fetchFiles(false);
            setShowCreateFolderModal(false);
        } else {
            const err = await res.json();
            alert('Failed to create folder: ' + err.error);
        }
    } catch (e) {
        alert('Failed to create folder');
    } finally {
        setLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!itemToDelete) return;
    
    let idsToDelete: number[] = [];
    if ('isFolder' in itemToDelete) {
      const folderPath = currentFolder === '/' 
        ? '/' + itemToDelete.name 
        : currentFolder + (currentFolder.endsWith('/') ? '' : '/') + itemToDelete.name;
      
      files.forEach(f => {
        let fFolder = f.folder || '/';
        if (!fFolder.startsWith('/')) fFolder = '/' + fFolder;

        if (fFolder === folderPath || fFolder.startsWith(folderPath + '/')) {
          idsToDelete.push(f.id);
        }
      });
    } else {
      idsToDelete.push((itemToDelete as TelegramFile).id);
    }

    try {
      setLoading(true);
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ids: idsToDelete })
      });
      if (res.ok) {
        fetchFiles();
        setItemToDelete(null);
      } else {
        const err = await res.json();
        alert('Delete failed: ' + err.error);
      }
    } catch(e) {
      alert('Delete failed');
    } finally {
      setLoading(false);
    }
  };

  const formatSize = (bytesStr: string) => {
    const bytes = parseInt(bytesStr);
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSendCode = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ phoneNumber }),
      });
      if (res.ok) setLoginStep('code');
      else {
        const err = await res.json();
        alert(err.error || 'Failed to send code');
      }
    } catch (err) { alert('Error sending code'); }
    finally { setLoading(false); }
  };

  const handleSignIn = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ phoneNumber, code: authCode }),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('telegram_session', data.session);
        setShowLogin(false);
        fetchAuthStatus();
        fetchFiles();
      } else {
        const err = await res.json();
        alert(err.error || 'Sign in failed');
      }
    } catch (err) { alert('Error during sign in'); }
    finally { setLoading(false); }
  };

  const handleUrlUpload = async () => {
    if (!urlInput.trim()) return;
    const url = urlInput;
    setShowUrlModal(false);
    setUrlInput('');
    
    let filename = 'URL Upload';
    try {
      const urlObj = new URL(url);
      const urlPath = urlObj.pathname.split('/').pop();
      if (urlPath) filename = urlPath;
    } catch(e) {}

    try {
      const startRes = await fetch('/api/upload/url/start', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url, folder: currentFolder })
      });
      if (!startRes.ok) {
        const data = await startRes.json();
        throw new Error(data.error || 'Failed to start URL upload');
      }
      
      const { uploadId } = await startRes.json();

      const newItem: QueuedUpload = {
        id: uploadId,
        name: filename,
        progress: 0,
        file: new window.File([new Blob()], filename) as File,
        path: currentFolder,
        status: 'uploading'
      };
      
      setActiveUploads(prev => [...prev, newItem]);
      setIsUploadManagerOpen(true);
      setIsUploadManagerMinimized(false);

      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/upload/url/status?uploadId=${uploadId}`, { headers: getHeaders() });
          if (!res.ok) {
            clearInterval(pollInterval);
            setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'failed' } : u));
            return;
          }
          const state = await res.json();
          if (state.status === 'downloading' || state.status === 'uploading') {
            setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, progress: state.progress } : u));
          } else if (state.status === 'completed') {
            clearInterval(pollInterval);
            setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'completed', progress: 100 } : u));
            fetchFiles();
          } else if (state.status === 'failed') {
            clearInterval(pollInterval);
            setActiveUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'failed' } : u));
            alert(`URL upload failed: ${state.error}`);
          }
        } catch (e) {
          console.error('Poll error', e);
        }
      }, 2000);

    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Error uploading from URL');
    }
  };

  const getFileIcon = (mimeType?: string) => {
    if (mimeType?.startsWith('image/')) return <ImageIcon className="text-blue-500" size={20} />;
    if (mimeType?.includes('pdf') || mimeType?.includes('word')) return <FileText className="text-red-500" size={20} />;
    return <FileIcon className="text-gray-500" size={20} />;
  };

  const currentLevelItems = React.useMemo(() => {
    const items: (TelegramFile | { isFolder: true; name: string })[] = [];
    const folders = new Set<string>();

    files.forEach(f => {
      let fFolder = f.folder || '/';
      if (!fFolder.startsWith('/')) fFolder = '/' + fFolder;

      const normCurrent = currentFolder === '/' ? '/' : currentFolder.replace(/\/$/, '');
      const normF = fFolder === '/' ? '/' : fFolder.replace(/\/$/, '');

      if (normF === normCurrent) {
          if (!f.isPlaceholder) items.push(f);
      } else if (normF.startsWith(normCurrent === '/' ? '/' : normCurrent + '/')) {
        const remainder = normF.substring(normCurrent === '/' ? 1 : normCurrent.length + 1);
        const subfolderName = remainder.split('/')[0];
        if (subfolderName && !folders.has(subfolderName)) {
           folders.add(subfolderName);
           items.push({ isFolder: true, name: subfolderName });
        }
      }
    });

    return items.sort((a, b) => {
      if ('isFolder' in a && !('isFolder' in b)) return -1;
      if (!('isFolder' in a) && 'isFolder' in b) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [files, currentFolder]);

  const filteredFiles = currentLevelItems.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));

  if (authStatus?.requiresAppPassword && !authStatus?.appPasswordValid) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-sm border w-full max-w-sm">
          <div className="flex justify-center mb-6"> <div className="p-4 bg-blue-100 rounded-full text-blue-600"> <Cloud size={40} /> </div> </div>
          <h2 className="text-xl font-bold text-center mb-2">Application Locked</h2>
          <p className="text-sm text-center text-neutral-500 mb-6"> This TeleDrive is private. Please enter the password to access it. </p>
          <div className="space-y-4">
            <input type="password" placeholder="Password..." value={appPasswordInput} onChange={e => setAppPasswordInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && setAppPassword(appPasswordInput)} className="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" />
            <button onClick={() => setAppPassword(appPasswordInput)} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-colors"> Unlock </button>
          </div>
        </div>
      </div>
    );
  }

  const triggerDownload = (url: string, defaultFilename: string = 'download') => {
    // Append app_password to URL if needed
    let finalUrl = url;
    if (appPassword) {
      const separator = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${separator}app_password=${encodeURIComponent(appPassword)}`;
    }

    if (window !== window.parent) {
      // In preview iframe, downloads might be blocked or have issues for large files.
      // Warn the user just in case, but attempt download anyway.
      // alert("PEMBERITAHUAN: Karena batasan iframe, file besar mungkin bermasalah. Klik tombol 'Open App in New Tab' di atas jika download gagal.");
    }

    const a = document.createElement('a');
    a.href = finalUrl;
    a.download = defaultFilename;
    // Removing target="_blank" ensures cookies are sent correctly within the same browsing context
    // and relies on Content-Disposition: attachment to prevent page unloading.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900 font-sans flex flex-col h-screen overflow-hidden">
      {/* Login Modal (Same as before) */}
      <AnimatePresence>
        {showLogin && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl relative">
              <div className="flex justify-center mb-6"> <div className="p-4 bg-blue-100 rounded-full text-blue-600"> <Cloud size={40} /> </div> </div>
              <h2 className="text-2xl font-bold text-center mb-2">Connect Telegram</h2>
              <p className="text-neutral-500 text-center mb-8 text-sm"> Login with your phone number for personal storage. </p>
              {loginStep === 'phone' ? (
                <div className="space-y-4">
                  <input type="text" placeholder="+6281..." value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} className="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" />
                  <button onClick={handleSendCode} disabled={loading} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"> {loading && <Loader2 className="animate-spin" size={20} />} Send Code </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <input type="text" placeholder="12345" value={authCode} onChange={(e) => setAuthCode(e.target.value)} className="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" />
                  <button onClick={handleSignIn} disabled={loading} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"> {loading && <Loader2 className="animate-spin" size={20} />} Verify & Login </button>
                  <button onClick={() => setLoginStep('phone')} className="w-full text-blue-600 text-sm font-medium"> Change Phone Number </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="h-16 border-b flex items-center justify-between px-2 md:px-4 bg-white z-50 gap-2 md:gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-600 rounded text-white hidden sm:block"><Cloud size={20} /></div>
          <h1 className="text-xl font-medium text-neutral-700 hidden sm:block">TeleDrive</h1>
        </div>

        <div className="flex-1 max-w-2xl min-w-0">
            <div className="relative group">
                <Search className="absolute left-3 md:left-4 top-1/2 -translate-y-1/2 text-neutral-400 group-focus-within:text-blue-500" size={18} />
                <input 
                    type="text" 
                    placeholder="Search in TeleDrive" 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-neutral-100 focus:bg-white border border-transparent focus:border-neutral-200 pl-10 md:pl-11 pr-4 py-2.5 rounded-full outline-none transition-all shadow-sm focus:shadow-md text-sm md:text-base"
                />
            </div>
        </div>

        <div className="flex items-center gap-1 md:gap-2">
            <button className="p-2 hover:bg-neutral-100 rounded-full text-neutral-500 hidden sm:block"><Settings size={20} /></button>
            <div className="w-8 h-8 shrink-0 bg-blue-100 rounded-full flex items-center justify-center text-blue-700 font-bold text-xs ring-2 ring-white">A</div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-white">
          <div className="px-4 md:px-6 py-3 flex items-center justify-between border-b bg-neutral-50/50">
            {selectedItems.size > 0 ? (
                <div className="flex items-center gap-4 w-full">
                    <button onClick={() => setSelectedItems(new Set())} className="p-2 hover:bg-neutral-200 rounded-full text-neutral-600"><X size={20} /></button>
                    <span className="font-semibold text-lg">{selectedItems.size} selected</span>
                    <div className="flex-1" />
                    <button onClick={handleBatchDownload} className="p-2 hover:bg-neutral-200 rounded-full text-neutral-600 tooltip" title="Download Selected"><Download size={20} /></button>
                    <button onClick={handleBatchDelete} className="p-2 hover:bg-red-100 rounded-full text-red-600 tooltip" title="Delete Selected"><Trash2 size={20} /></button>
                </div>
            ) : (
            <>
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                <button 
                  onClick={() => { setSelectedItems(new Set()); setCurrentFolder('/'); }}
                  className="flex items-center gap-2 hover:bg-neutral-100 px-3 py-1.5 rounded-lg font-medium text-lg text-neutral-700"
                >
                  My Drive <ChevronDown size={14} className="mt-1" />
                </button>
                {currentFolder !== '/' && currentFolder.split('/').filter(Boolean).map((part, i, arr) => (
                    <React.Fragment key={i}>
                        <ChevronRight size={14} className="text-neutral-400" />
                        <button 
                            onClick={() => { setSelectedItems(new Set()); setCurrentFolder('/' + arr.slice(0, i+1).join('/')); }}
                            className="hover:bg-neutral-100 px-2 py-1 rounded-lg text-neutral-600 truncate max-w-[120px]"
                        >
                            {part}
                        </button>
                    </React.Fragment>
                ))}
            </div>

            <div className="flex items-center gap-2">
                <button 
                    onClick={() => setViewMode(viewMode === 'list' ? 'grid' : 'list')}
                    className="p-2 hover:bg-neutral-100 rounded-full text-neutral-500"
                >
                    {viewMode === 'list' ? <Grid size={20} /> : <FileText size={20} />}
                </button>
                <button className="p-2 hover:bg-neutral-100 rounded-full text-neutral-500"><Settings size={20} /></button>
            </div>
            </>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-2 md:px-6 py-4">
            {loading ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-neutral-400">
                    <Loader2 className="animate-spin" size={32} />
                    <p>Fetching files from Telegram...</p>
                </div>
            ) : filteredFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-neutral-400">
                    <Cloud size={64} className="opacity-20" />
                    <p className="text-lg">No files here yet</p>
                    <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="text-blue-600 font-medium hover:underline"
                    >
                        Upload some files
                    </button>
                </div>
            ) : (
                <table className="w-full text-left">
                    <thead className="text-xs font-semibold text-neutral-500 uppercase tracking-wider sticky top-0 bg-white">
                        <tr className="border-b">
                            <th className="pb-3 pl-2 md:pl-4 w-10">
                                <input type="checkbox" onChange={(e) => {
                                    if (e.target.checked) setSelectedItems(new Set(filteredFiles.map(getItemId)));
                                    else setSelectedItems(new Set());
                                }} checked={selectedItems.size === filteredFiles.length && filteredFiles.length > 0} className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" />
                            </th>
                            <th className="pb-3">Name</th>
                            <th className="pb-3 hidden md:table-cell">Last modified</th>
                            <th className="pb-3 hidden md:table-cell">File size</th>
                            <th className="pb-3 text-right pr-2 md:pr-4">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y text-sm">
                        {filteredFiles.map((file, idx) => {
                            const isFolder = 'isFolder' in file;
                            const itemId = getItemId(file);
                            return (
                                <tr key={idx} className={`group hover:bg-neutral-50 transition-colors cursor-pointer ${selectedItems.has(itemId) ? 'bg-blue-50/50' : ''}`} onClick={(e) => {
                                    if (isFolder && !(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                                        setCurrentFolder(prev => prev === '/' ? '/' + file.name : prev + '/' + file.name);
                                    } else {
                                        toggleSelection(itemId);
                                    }
                                }}>
                                    <td className="py-3.5 pl-2 md:pl-4 w-10" onClick={e => e.stopPropagation()}>
                                        <input type="checkbox" checked={selectedItems.has(itemId)} onChange={() => toggleSelection(itemId)} className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" />
                                    </td>
                                    <td className="py-3.5 max-w-[150px] sm:max-w-[300px] md:max-w-[400px]">
                                        <div className="flex items-center gap-2 md:gap-3">
                                          <div className="shrink-0">{isFolder ? <div className="text-neutral-400">📁</div> : getFileIcon((file as TelegramFile).mimeType)}</div>
                                          <span className="font-medium text-neutral-700 truncate block">{file.name}</span>
                                        </div>
                                    </td>
                                    <td className="py-3.5 text-neutral-500 hidden md:table-cell">
                                        {!isFolder ? new Date((file as TelegramFile).date * 1000).toLocaleDateString() : '--'}
                                    </td>
                                    <td className="py-3.5 text-neutral-500 hidden md:table-cell">
                                        {!isFolder ? formatSize((file as TelegramFile).size) : '--'}
                                    </td>
                                    <td className="py-3.5 text-right pr-2 md:pr-4">
                                        <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                                            {!isFolder && (
                                                <>
                                                    <button onClick={() => {
                                                        const url = `${window.location.origin}/api/download/${(file as TelegramFile).id}`;
                                                        navigator.clipboard.writeText(url);
                                                        alert(`Direct download link copied to clipboard!\n\nLink: ${url}\n\nNote: This link bypasses the app password and can be shared publicly.`);
                                                    }} className="p-2 hover:bg-green-100 rounded-full text-neutral-500 hover:text-green-600 transition-colors" title="Share direct download link"><Share2 size={18} /></button>
                                                    <button onClick={() => triggerDownload(`/api/download/${(file as TelegramFile).id}`, file.name)} className="p-2 hover:bg-blue-100 rounded-full text-neutral-500 hover:text-blue-600 transition-colors" title="Download file"><Download size={18} /></button>
                                                </>
                                            )}
                                            {isFolder && (
                                                <button onClick={() => {
                                                    const folderPath = currentFolder === '/' ? '/' + file.name : currentFolder + '/' + file.name;
                                                    triggerDownload(`/api/download-folder?path=${encodeURIComponent(folderPath)}`, file.name + '.zip');
                                                }} className="p-2 hover:bg-blue-100 rounded-full text-neutral-500 hover:text-blue-600 transition-colors" title="Download folder as ZIP"><Download size={18} /></button>
                                            )}
                                            <button onClick={() => setItemToDelete(file)} className="p-2 hover:bg-red-100 rounded-full text-neutral-500 hover:text-red-600 transition-colors" title="Delete"><Trash2 size={18} /></button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
          </div>
          
          {/* FAB */}
          <div className={`fixed right-6 z-[100] group transition-all duration-300 ${isUploadManagerOpen && activeUploads.length > 0 ? (isUploadManagerMinimized ? 'bottom-[80px]' : 'bottom-[424px]') : 'bottom-6'}`}>
            <button 
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-lg shadow-blue-600/30 active:scale-95 transition-transform"
            >
              <Plus className="text-white" size={28} />
            </button>
            <AnimatePresence>
                {showNewMenu && (
                    <motion.div 
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        className="absolute bottom-16 right-0 mb-2 w-56 bg-white rounded-xl shadow-xl border py-2 flex flex-col z-50 origin-bottom-right"
                    >
                        <button onClick={() => { setShowNewMenu(false); setShowCreateFolderModal(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50 text-sm"><FolderPlus size={18} /> New folder</button>
                        <div className="h-px bg-neutral-100 my-1" />
                        <button onClick={() => { setShowNewMenu(false); fileInputRef.current?.click(); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50 text-sm"><Upload size={18} /> File upload</button>
                        <button onClick={() => { setShowNewMenu(false); folderInputRef.current?.click(); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50 text-sm"><FolderUp size={18} /> Folder upload</button>
                        <div className="h-px bg-neutral-100 my-1" />
                        <button onClick={() => { setShowNewMenu(false); setShowUrlModal(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50 text-sm"><Link2 size={18} /> Upload from URL</button>
                    </motion.div>
                )}
            </AnimatePresence>
          </div>
        </main>
      </div>

      <input type="file" ref={fileInputRef} onChange={handleFileUpload} multiple className="hidden" />
      <input type="file" ref={folderInputRef} onChange={handleFolderUpload} // @ts-ignore
        webkitdirectory="" directory="" className="hidden" />

      {/* Modals */}
      <AnimatePresence>
        {showCreateFolderModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl relative">
              <h2 className="text-xl font-bold mb-4">New folder</h2>
              <input 
                autoFocus
                type="text" 
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                placeholder="Folder name"
                className="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none mb-6"
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmCreateFolder();
                }}
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowCreateFolderModal(false)} className="px-4 py-2 rounded-xl font-medium text-neutral-600 hover:bg-neutral-100">Cancel</button>
                <button onClick={confirmCreateFolder} disabled={!newFolderName.trim() || loading} className="px-4 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 flex items-center gap-2">
                  {loading && <Loader2 className="animate-spin" size={16} />} Create
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {showUrlModal && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl relative">
              <h2 className="text-xl font-bold mb-4">Upload from URL</h2>
              <input 
                autoFocus
                type="url" 
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                placeholder="https://example.com/file.pdf"
                className="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none mb-6"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleUrlUpload();
                }}
              />
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowUrlModal(false)} className="px-4 py-2 rounded-xl font-medium text-neutral-600 hover:bg-neutral-100">Cancel</button>
                <button onClick={handleUrlUpload} disabled={!urlInput.trim() || loading} className="px-4 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 flex items-center gap-2">
                  {loading && <Loader2 className="animate-spin" size={16} />} Upload
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {itemToDelete && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl relative">
              <h2 className="text-xl font-bold mb-2">Delete {itemToDelete.isFolder ? 'folder' : 'file'}?</h2>
              <p className="text-neutral-500 mb-6 text-sm">
                Are you sure you want to delete "{itemToDelete.name}"? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3">
                <button onClick={() => setItemToDelete(null)} className="px-4 py-2 rounded-xl font-medium text-neutral-600 hover:bg-neutral-100">Cancel</button>
                <button onClick={confirmDelete} disabled={loading} className="px-4 py-2 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 flex items-center gap-2">
                  {loading && <Loader2 className="animate-spin" size={16} />} Delete
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Upload Manager (Drive Style) */}
      <AnimatePresence>
        {isUploadManagerOpen && activeUploads.length > 0 && (
            <motion.div 
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className={`fixed bottom-0 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-w-full bg-white rounded-t-xl shadow-2xl border flex flex-col z-[300] overflow-hidden transition-all ${isUploadManagerMinimized ? 'h-[52px]' : 'h-[400px]'}`}
            >
                {/* Header */}
                <div className="bg-neutral-800 text-white flex items-center justify-between px-4 py-3.5 shrink-0">
                    <p className="text-sm font-medium">
                        {activeUploads.some(u => u.status === 'uploading') 
                            ? `Uploading ${activeUploads.filter(u => u.status === 'uploading').length} items...`
                            : `${activeUploads.filter(u => u.status === 'completed').length} uploads complete`}
                    </p>
                    <div className="flex items-center gap-1">
                        <button onClick={() => setIsUploadManagerMinimized(!isUploadManagerMinimized)} className="p-1 hover:bg-white/20 rounded">
                            {isUploadManagerMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
                        </button>
                        <button onClick={() => {
                            setIsUploadManagerOpen(false);
                            setActiveUploads([]);
                        }} className="p-1 hover:bg-white/20 rounded">
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-2">
                    {activeUploads.map((upload) => (
                        <div key={upload.id} className="flex flex-col p-3 hover:bg-neutral-50 border-b last:border-0">
                            <div className="flex items-center gap-3">
                                {getFileIcon(upload.file.type)}
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium truncate text-neutral-700">{upload.file.name}</p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="flex-1 bg-neutral-100 h-1 rounded-full overflow-hidden">
                                            <div 
                                                className={`h-full transition-all duration-300 ${upload.status === 'failed' ? 'bg-red-500' : upload.status === 'canceled' ? 'bg-neutral-400' : 'bg-blue-600'}`}
                                                style={{ width: `${upload.progress}%` }}
                                            />
                                        </div>
                                        <span className="text-[10px] text-neutral-400 whitespace-nowrap">
                                            {upload.status === 'uploading' ? `${upload.progress}%` : upload.status}
                                        </span>
                                    </div>
                                </div>
                                {upload.status === 'completed' && <CheckCircle className="text-green-500" size={16} />}
                                {upload.status === 'failed' && <AlertCircle className="text-red-500" size={16} />}
                                {upload.status === 'canceled' && <X className="text-neutral-400" size={16} />}
                                {(upload.status === 'pending' || upload.status === 'uploading') && (
                                    <button 
                                        onClick={(e) => cancelUpload(upload.id, e)}
                                        className="p-1 hover:bg-neutral-200 rounded-full text-neutral-400 hover:text-neutral-700 transition-colors"
                                        title="Cancel upload"
                                    >
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
