import { UserPreferencesOperations, getDbType } from '../db/bal/business-adapter';

/**
 * 用户偏好设置服务
 */

export interface UserPreferences {
  userId: number;
  theme: 'light' | 'dark' | 'auto';
  language: string;
  notificationsEnabled: boolean;
  emailNotifications: boolean;
  backgroundImage?: string;
  avatarImage?: string;
  /** 背景蒙层不透明度 0-100（默认 100）。只作用于 --scrim-alpha */
  backgroundOpacity?: number;
}

/**
 * 获取用户偏好设置
 */
export async function getUserPreferences(userId: number): Promise<UserPreferences> {
  const result = await UserPreferencesOperations.get(userId);

  if (!result) {
    return {
      userId,
      theme: 'auto',
      language: 'zh-CN',
      notificationsEnabled: true,
      emailNotifications: true,
      backgroundImage: undefined,
      avatarImage: undefined,
    };
  }

  return {
    userId,
    theme: (result as any).theme || 'auto',
    language: (result as any).language || 'zh-CN',
    notificationsEnabled: !!(result as any).notifications_enabled,
    emailNotifications: !!(result as any).email_notifications,
    backgroundImage: (result as any).background_image || undefined,
    avatarImage: (result as any).avatar_image || undefined,
    backgroundOpacity: typeof (result as any).background_opacity === 'number' ? (result as any).background_opacity : 100,
  };
}

function clampOpacity(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * 更新用户偏好设置
 */
export async function updateUserPreferences(
  userId: number,
  preferences: Partial<UserPreferences>
): Promise<void> {
  const current = await getUserPreferences(userId);
  const updated = { ...current, ...preferences };

  const dbType = getDbType();
  const notificationsEnabled = updated.notificationsEnabled ? 1 : 0;
  const emailNotifications = updated.emailNotifications ? 1 : 0;
  const backgroundImage = updated.backgroundImage || null;
  const avatarImage = updated.avatarImage || null;

  if (dbType === 'sqlite') {
    await UserPreferencesOperations.upsertSQLite(
      userId,
      updated.theme,
      updated.language,
      notificationsEnabled,
      emailNotifications,
      backgroundImage,
      avatarImage,
      clampOpacity(updated.backgroundOpacity)
    );
  } else if (dbType === 'mysql') {
    await UserPreferencesOperations.upsertMySQL(
      userId,
      updated.theme,
      updated.language,
      notificationsEnabled,
      emailNotifications,
      backgroundImage,
      avatarImage,
      clampOpacity(updated.backgroundOpacity)
    );
  } else {
    await UserPreferencesOperations.upsertPostgreSQL(
      userId,
      updated.theme,
      updated.language,
      notificationsEnabled,
      emailNotifications,
      backgroundImage,
      avatarImage,
      clampOpacity(updated.backgroundOpacity)
    );
  }
}
