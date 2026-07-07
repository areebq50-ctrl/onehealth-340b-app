import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Loader2, User } from 'lucide-react';
import { supabase } from '../lib/supabaseClient.js';
import { useToast } from '../context/ToastContext.jsx';
import { useFacility } from '../context/FacilityContext.jsx';
import MarkdownLite from '../components/assistant/MarkdownLite.jsx';
import ScopeLabel from '../components/common/ScopeLabel.jsx';
import FacilityPharmacySelector from '../components/common/FacilityPharmacySelector.jsx';

const SUGGESTIONS = [
  'What is the total reimbursement owed this month?',
  'Which drugs had the highest dispensing volume this month?',
  'Show me all unmatched NDCs from the last 30 days',
  'Which drugs are expiring in the next 60 days?',
];

export default function AIAssistant() {
  const toast = useToast();
  const { selectedFacilityId, selectedPharmacyId, selectedFacility, selectedPharmacy } = useFacility();
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi, I'm the One.Health Partners AI Assistant. Ask me about claims, reimbursement totals, drug inventory, or unmatched NDCs — I'll answer using live data from the platform.",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const newMessages = [...messages, { role: 'user', content: trimmed }];
    setMessages(newMessages);
    setInput('');
    setSending(true);

    try {
      const history = newMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(0, -1) // exclude the message we're about to send separately in the request body
        .map((m) => ({ role: m.role, content: m.content }));

      const { data, error } = await supabase.functions.invoke('ai-assistant', {
        body: {
          message: trimmed,
          history,
          scope: {
            facilityId: selectedFacilityId !== 'all' ? selectedFacilityId : null,
            facilityName: selectedFacilityId !== 'all' ? selectedFacility?.name ?? null : null,
            pharmacyId: selectedPharmacyId !== 'all' ? selectedPharmacyId : null,
            pharmacyName: selectedPharmacyId !== 'all' ? selectedPharmacy?.name ?? null : null,
          },
        },
      });

      if (error) {
        // supabase-js only gives a generic "non-2xx status code" message for
        // FunctionsHttpError — the real reason (bad key, blocked response,
        // etc.) is in the function's JSON response body on error.context.
        let detail = error.message;
        if (error.context && typeof error.context.json === 'function') {
          try {
            const body = await error.context.json();
            if (body?.error) detail = body.error;
          } catch {
            // response body wasn't JSON — fall back to the generic message
          }
        }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);

      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      toast.error(`Assistant request failed: ${err.message}`);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Sorry, I ran into an error answering that: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-teal" />
        <h1 className="text-xl font-bold text-navy">AI Assistant</h1>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3">
        <FacilityPharmacySelector />
        <ScopeLabel className="ml-auto" />
      </div>

      <div ref={scrollRef} className="card mb-4 flex-1 space-y-4 overflow-y-auto p-6">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                m.role === 'user' ? 'bg-teal text-white' : 'bg-teal-50 text-teal-700'
              }`}
            >
              {m.role === 'user' ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            </div>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 ${m.role === 'user' ? 'bg-teal text-white' : 'bg-surface-alt text-navy'}`}>
              {m.role === 'user' ? <p className="text-sm">{m.content}</p> : <MarkdownLite text={m.content} />}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking...
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="btn-secondary text-xs" onClick={() => sendMessage(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage(input);
        }}
        className="flex gap-2"
      >
        <input
          className="input-field"
          placeholder="Ask about claims, reimbursement, or inventory..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
        />
        <button type="submit" className="btn-primary" disabled={sending || !input.trim()}>
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
