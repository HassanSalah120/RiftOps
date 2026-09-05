import React, { useState, useEffect, useCallback } from 'react';
import { Minus, X } from 'lucide-react';

declare global {
  interface Window {
    riftopsMinimizeWindow?: () => void;
    riftopsMaximizeWindow?: () => void;
    riftopsCloseWindow?: () => void;
    riftopsStartWindowDrag?: () => void;
    riftopsIsWindowMaximized?: () => boolean;
  }
}

interface TitleBarProps {
  remoteClient?: boolean;
  phase?: string;
  isLive?: boolean;
}

export default function TitleBar({ remoteClient = false, phase = 'idle', isLive = false }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  // Poll or check window maximized state
  const checkMaximized = useCallback(async () => {
    if (typeof window.riftopsIsWindowMaximized === 'function') {
      try {
        const val = window.riftopsIsWindowMaximized();
        setIsMaximized(Boolean(val));
      } catch {
        // Fallback or ignore
      }
    } else {
      try {
        const res = await fetch('/api/window/state');
        if (res.ok) {
          const data = await res.json();
          setIsMaximized(Boolean(data.maximized));
        }
      } catch {
        // Ignore in browser-only mode
      }
    }
  }, []);

  useEffect(() => {
    checkMaximized();
    const handleResize = () => {
      checkMaximized();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [checkMaximized]);

  const handleMinimize = async () => {
    if (typeof window.riftopsMinimizeWindow === 'function') {
      window.riftopsMinimizeWindow();
    } else {
      fetch('/api/window/minimize', { method: 'POST' }).catch(() => {});
    }
  };

  const handleMaximizeToggle = async () => {
    if (typeof window.riftopsMaximizeWindow === 'function') {
      window.riftopsMaximizeWindow();
    } else {
      await fetch('/api/window/maximize', { method: 'POST' }).catch(() => {});
    }
    setTimeout(checkMaximized, 100);
  };

  const handleClose = async () => {
    if (typeof window.riftopsCloseWindow === 'function') {
      window.riftopsCloseWindow();
    } else {
      fetch('/api/window/close', { method: 'POST' }).catch(() => {});
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only left click triggers drag
    if (e.button !== 0) return;
    // Don't drag if clicked on button
    if ((e.target as HTMLElement).closest('.riftops-titlebar__control')) return;

    if (typeof window.riftopsStartWindowDrag === 'function') {
      window.riftopsStartWindowDrag();
    }
  };

  // If accessed remotely (e.g. from phone), do not render desktop title bar
  if (remoteClient) {
    return null;
  }

  return (
    <header
      className="riftops-titlebar"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleMaximizeToggle}
      role="banner"
      aria-label="Window header"
    >
      {/* Left: Brand Identity */}
      <div className="riftops-titlebar__brand">
        <img
          src="/branding/riftops-logo.png"
          alt=""
          className="riftops-titlebar__crest"
          width="18"
          height="18"
        />
        <span className="riftops-titlebar__title">RiftOps</span>
        <span className="riftops-titlebar__subtitle">League Companion</span>
      </div>

      {/* Center: Draggable Workspace Hub */}
      <div className="riftops-titlebar__drag-region">
        {isLive && (
          <div className="riftops-titlebar__live-pill">
            <span className="riftops-titlebar__live-dot" />
            <span>{phase.toUpperCase()} SESSION</span>
          </div>
        )}
      </div>

      {/* Right: Window Controls */}
      <div className="riftops-titlebar__controls" aria-label="Window controls">
        <button
          type="button"
          className="riftops-titlebar__control riftops-titlebar__control--minimize"
          onClick={handleMinimize}
          title="Minimize to system tray"
          aria-label="Minimize"
        >
          <Minus className="w-3.5 h-3.5 stroke-[1.5]" />
        </button>

        <button
          type="button"
          className="riftops-titlebar__control riftops-titlebar__control--maximize"
          onClick={handleMaximizeToggle}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="2.5" y="5.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5.5 5.5V3.5C5.5 2.94772 5.94772 2.5 6.5 2.5H12.5C13.0523 2.5 13.5 2.94772 13.5 3.5V9.5C13.5 10.0523 13.0523 10.5 12.5 10.5H10.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="riftops-titlebar__control riftops-titlebar__control--close"
          onClick={handleClose}
          title="Close to tray"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5 stroke-[1.5]" />
        </button>
      </div>
    </header>
  );
}
