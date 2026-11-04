import { AnimatePresence, motion } from 'framer-motion';
import { Phone, PhoneOff } from 'lucide-react';
import { useCalls } from '@/stores/calls';
import { useProfile } from '@/stores/profiles';
import { useVoice } from '@/stores/voice';
import { useUi } from '@/stores/ui';
import { Avatar } from '@/components/ui/Avatar';

export function IncomingCall() {
  const call = useCalls((s) => s.incoming);
  const caller = useProfile(call?.from);
  const accept = async () => {
    if (!call) return;
    useCalls.getState().dismiss();
    useUi.getState().setView({ kind: 'dm', dmId: call.dmId });
    useUi.getState().setVoiceViewOpen(true);
    await useVoice.getState().join({ kind: 'dm', dmId: call.dmId, peerId: call.from, name: caller?.display_name ?? 'Звонок' });
  };
  return (
    <AnimatePresence>
      {call && (
        <motion.div
          initial={{ opacity: 0, y: -30, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -30, scale: 0.95 }}
          className="glass-strong fixed left-1/2 top-14 z-[75] flex w-[340px] -translate-x-1/2 items-center gap-4 rounded-2xl p-4 shadow-glass"
        >
          <div className="animate-pulseRing rounded-full">
            <Avatar userId={call.from} size={52} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-white">{caller?.display_name ?? '…'}</div>
            <div className="text-sm text-slate-400">Входящий звонок</div>
          </div>
          <button className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-500 text-white hover:bg-rose-400" title="Отклонить" onClick={() => useCalls.getState().dismiss()}>
            <PhoneOff className="h-5 w-5" />
          </button>
          <button className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-400" title="Принять" onClick={() => void accept()}>
            <Phone className="h-5 w-5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
