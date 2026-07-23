// AIcut AI功能守卫 — 调用AI功能前检查配置，未配置则引导用户去配置向导
import React, { useState, useCallback } from 'react';
import type { AIcutConfig } from './ai_config';
import { isAIConfigured, isASRConfigured, isTTSConfigured, getDefaultConfig } from './ai_config';
import ConfigWizard from './ConfigWizard';

// 守卫检查的功能类型
export type GuardFeature = 'ai' | 'asr' | 'tts';

// 检查某功能是否已配置
function checkFeature(config: AIcutConfig | null, feature: GuardFeature): boolean {
  const cfg = config || getDefaultConfig();
  if (feature === 'ai') return isAIConfigured(cfg);
  if (feature === 'asr') return isASRConfigured(cfg);
  return isTTSConfigured(cfg);
}

// 功能中文名
const FEATURE_NAMES: Record<GuardFeature, string> = {
  ai: 'AI大模型',
  asr: '语音识别(ASR)',
  tts: '文字转语音(TTS)',
};

// 守卫提示Modal
function GuardPrompt({ feature, onConfirm, onCancel }: { feature: GuardFeature; onConfirm: () => void; onCancel: () => void }) {
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 };
  const modal: React.CSSProperties = { width: 380, background: '#1a1a2e', borderRadius: 8, border: '1px solid #0f3460', color: '#eee', fontFamily: 'system-ui' };
  const body: React.CSSProperties = { padding: 24, textAlign: 'center' };
  const footer: React.CSSProperties = { padding: '12px 20px', borderTop: '1px solid #16213e', display: 'flex', gap: 8, justifyContent: 'center' };
  const btnP: React.CSSProperties = { padding: '8px 18px', background: '#e94560', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 };
  const btnG: React.CSSProperties = { padding: '8px 18px', background: 'transparent', color: '#aaa', border: '1px solid #0f3460', borderRadius: 4, cursor: 'pointer', fontSize: 13 };
  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={body}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            此功能需要配置{FEATURE_NAMES[feature]}，<br />是否现在配置？
          </div>
        </div>
        <div style={footer}>
          <button style={btnG} onClick={onCancel}>取消</button>
          <button style={btnP} onClick={onConfirm}>去配置</button>
        </div>
      </div>
    </div>
  );
}

// AI守卫Hook
// 使用：const { checkAndCall, guardModal } = useAIGuard(config);
// guardModal 需要在组件中渲染
export function useAIGuard(config: AIcutConfig | null) {
  const [pendingFeature, setPendingFeature] = useState<GuardFeature | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  // 待执行的回调（配置完成后继续执行）
  const [pendingCallback, setPendingCallback] = useState<(() => void) | null>(null);

  // 检查并调用：如果已配置则直接调用，否则弹出提示
  const checkAndCall = useCallback((feature: GuardFeature, callback: () => void) => {
    if (checkFeature(config, feature)) {
      callback();
      return;
    }
    // 未配置，保存回调并弹出提示
    setPendingCallback(() => callback);
    setPendingFeature(feature);
  }, [config]);

  // 确认去配置 → 打开向导
  const handleConfirm = useCallback(() => {
    setShowWizard(true);
    setPendingFeature(null);
  }, []);

  // 取消提示
  const handleCancel = useCallback(() => {
    setPendingFeature(null);
    setPendingCallback(null);
  }, []);

  // 向导完成
  const handleWizardComplete = useCallback((newConfig: AIcutConfig) => {
    setShowWizard(false);
    // 配置向导不直接保存，交由外层处理
    // 这里触发外部onComplete回调链由调用方控制
    if (pendingCallback) {
      pendingCallback();
      setPendingCallback(null);
    }
  }, [pendingCallback]);

  // 向导取消
  const handleWizardCancel = useCallback(() => {
    setShowWizard(false);
    setPendingCallback(null);
  }, []);

  // 需要渲染的UI（提示Modal + 配置向导）
  let guardModal: React.ReactNode = null;
  if (pendingFeature) {
    guardModal = <GuardPrompt feature={pendingFeature} onConfirm={handleConfirm} onCancel={handleCancel} />;
  } else if (showWizard) {
    guardModal = <ConfigWizard initialConfig={config || getDefaultConfig()} onComplete={handleWizardComplete} onCancel={handleWizardCancel} />;
  }

  return { checkAndCall, guardModal };
}
