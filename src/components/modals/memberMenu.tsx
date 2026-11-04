import { Ban, Copy, MessageSquare, Shield, ShieldCheck, User, UserMinus, UserPlus, UserX } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useServers } from '@/stores/servers';
import { useSocial } from '@/stores/social';
import { toast, useUi, type ContextMenuItem } from '@/stores/ui';
import { ROLE_RANK, type ServerRole } from '@/lib/types';
import { useProfiles } from '@/stores/profiles';

export async function openDmWith(userId: string) {
  try {
    const id = await useSocial.getState().openDm(userId);
    useUi.getState().setView({ kind: 'dm', dmId: id });
    useUi.getState().closeModal();
  } catch (e) {
    toast.error('Не удалось открыть переписку', (e as Error).message);
  }
}

/** Контекстное меню участника (учитывает права текущего пользователя) */
export function memberMenu(e: { clientX: number; clientY: number }, serverId: string | null, userId: string) {
  const me = useAuth.getState().userId;
  const ui = useUi.getState();
  const items: ContextMenuItem[] = [
    { label: 'Профиль', icon: <User />, onClick: () => ui.openModal({ type: 'profile', userId, serverId: serverId ?? undefined }) },
  ];
  if (userId !== me) {
    items.push({ label: 'Написать сообщение', icon: <MessageSquare />, onClick: () => void openDmWith(userId) });
    const social = useSocial.getState();
    const friendship = social.friendships.find((f) => f.requester_id === userId || f.addressee_id === userId);
    if (!friendship) {
      const username = useProfiles.getState().byId[userId]?.username;
      if (username)
        items.push({
          label: 'Добавить в друзья',
          icon: <UserPlus />,
          onClick: () =>
            void social.sendRequest(username).then(
              () => toast.success('Заявка отправлена'),
              (err) => toast.error('Ошибка', err.message),
            ),
        });
    } else if (friendship.status === 'accepted') {
      items.push({ label: 'Пригласить на сервер', icon: <UserPlus />, onClick: () => ui.openModal({ type: 'inviteFriend', userId }) });
    }
  }
  items.push({ label: 'Копировать ID', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(userId) });

  if (serverId && userId !== me) {
    const s = useServers.getState();
    const myRole = s.myRoles[serverId];
    const target = s.members[serverId]?.find((m) => m.user_id === userId);
    if (myRole && target && ROLE_RANK[myRole] > ROLE_RANK[target.role]) {
      items.push({ separator: true, label: '' });
      const roles: ServerRole[] = ['admin', 'moderator', 'member'];
      if (ROLE_RANK[myRole] >= ROLE_RANK.admin) {
        for (const r of roles.filter((r) => ROLE_RANK[r] < ROLE_RANK[myRole] && r !== target.role)) {
          items.push({
            label: r === 'admin' ? 'Сделать администратором' : r === 'moderator' ? 'Сделать модератором' : 'Снять роль',
            icon: r === 'admin' ? <ShieldCheck /> : r === 'moderator' ? <Shield /> : <UserMinus />,
            onClick: () =>
              void s.setRole(serverId, userId, r).then(
                () => toast.success('Роль изменена'),
                (err) => toast.error('Ошибка', err.message),
              ),
          });
        }
      }
      items.push({
        label: 'Выгнать',
        icon: <UserX />,
        danger: true,
        onClick: () =>
          ui.openModal({
            type: 'confirm',
            title: 'Выгнать участника?',
            body: 'Он сможет вернуться по новому приглашению.',
            confirmLabel: 'Выгнать',
            danger: true,
            onConfirm: () => s.kick(serverId, userId),
          }),
      });
      if (ROLE_RANK[myRole] >= ROLE_RANK.admin) {
        items.push({
          label: 'Забанить',
          icon: <Ban />,
          danger: true,
          onClick: () =>
            ui.openModal({
              type: 'confirm',
              title: 'Забанить участника?',
              body: 'Пользователь будет исключён и не сможет вернуться, пока бан не снят.',
              confirmLabel: 'Забанить',
              danger: true,
              onConfirm: () => s.ban(serverId, userId, ''),
            }),
        });
      }
    }
  }
  ui.openContextMenu(e, items);
}
