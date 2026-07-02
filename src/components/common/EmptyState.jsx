import { Inbox } from 'lucide-react';

export default function EmptyState({ icon: Icon = Inbox, title, message, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-50">
        <Icon className="h-7 w-7 text-teal" />
      </div>
      <h3 className="text-base font-semibold text-navy">{title}</h3>
      {message && <p className="max-w-sm text-sm text-gray-500">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
