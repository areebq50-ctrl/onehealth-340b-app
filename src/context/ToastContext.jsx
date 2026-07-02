import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const STYLES = {
  success: 'bg-white border-l-4 border-success text-navy',
  error: 'bg-white border-l-4 border-danger text-navy',
  warning: 'bg-white border-l-4 border-warning text-navy',
  info: 'bg-white border-l-4 border-teal text-navy',
};

const ICON_COLORS = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-teal',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type, message, durationMs = 5000) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, type, message }]);
      if (durationMs > 0) {
        setTimeout(() => removeToast(id), durationMs);
      }
      return id;
    },
    [removeToast]
  );

  const toast = {
    success: (msg) => addToast('success', msg),
    error: (msg) => addToast('error', msg, 8000),
    warning: (msg) => addToast('warning', msg, 7000),
    info: (msg) => addToast('info', msg),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div key={t.id} className={`flex items-start gap-3 rounded-lg p-4 shadow-lg ${STYLES[t.type]}`}>
              <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${ICON_COLORS[t.type]}`} />
              <p className="flex-1 text-sm">{t.message}</p>
              <button onClick={() => removeToast(t.id)} className="text-gray-400 hover:text-gray-600">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
