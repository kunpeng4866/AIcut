// AIcut 配置向导 — 首次启动或AI未配置时显示
import React, { useState } from 'react';
import type { AIcutConfig, AIProviderConfig, ASRConfig, TTSConfig } from './ai_config';
import { getDefaultConfig } from './ai_config';

// 深色主题内联样式
const theme = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 } as React.CSSProperties,
  modal: { width: 520, maxHeight: '90vh', overflowY: 'auto', background: '#1a1a2e', borderRadius: 8, border: '1px solid #0f3460', color: '#eee', fontFamily: 'system-ui' } as React.CSSProperties,
  header: { padding: '16px 20px', borderBottom: '1px solid #16213e', fontSize: 16, fontWeight: 600 } as React.CSSProperties,
  body: { padding: 20 } as React.CSSProperties,
  desc: { fontSize: 12, color: '#aaa', marginBottom: 16, lineHeight: 1.6 } as React.CSSProperties,
  label: { fontSize: 12, color: '#aaa', marginBottom: 4, display: 'block' } as React.CSSProperties,
  input: { width: '100%', padding: '8px 10px', background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, color: '#eee', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' as const } as React.CSSProperties,
  footer: { padding: '12px 20px', borderTop: '1px solid #16213e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } as React.CSSProperties,
  btnPrimary: { padding: '8px 18px', background: '#e94560', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 } as React.CSSProperties,
  btnGhost: { padding: '8px 18px', background: 'transparent', color: '#aaa', border: '1px solid #0f3460', borderRadius: 4, cursor: 'pointer', fontSize: 13 } as React.CSSProperties,
  stepDots: { display: 'flex', gap: 6 } as React.CSSProperties,
  dot: (active: boolean) => ({ width: 8, height: 8, borderRadius: '50%', background: active ? '#e94560' : '#0f3460' } as React.CSSProperties),
};

interface Props {
  initialConfig?: AIcutConfig;
  onComplete: (config: AIcutConfig) => void;
  onCancel?: () => void;
}

const STEPS = ['AI大模型', '语音识别', '文字转语音', '完成'];

export default function ConfigWizard({ initialConfig, onComplete, onCancel }: Props) {
  const [step, setStep] = useState(0);
  const [cfg, setCfg] = useState<AIcutConfig>(initialConfig || getDefaultConfig());

  const updateAI = (patch: Partial<AIProviderConfig>) => setCfg(c => ({ ...c, ai: { ...c.ai, ...patch } }));
  const updateASR = (patch: Partial<ASRConfig>) => setCfg(c => ({ ...c, asr: { ...c.asr, ...patch } }));
  const updateTTS = (patch: Partial<TTSConfig>) => setCfg(c => ({ ...c, tts: { ...c.tts, ...patch } }));

  const next = () => setStep(s => Math.min(s + 1, 3));
  const prev = () => setStep(s => Math.max(s - 1, 0));
  const skip = () => next();

  const canFinish = step === 3;
  const handlePrimary = () => {
    if (canFinish) onComplete(cfg);
    else next();
  };

  return (
    <div style={theme.overlay}>
      <div style={theme.modal}>
        <div style={theme.header}>
          AIcut 配置向导
          <div style={{ ...theme.stepDots, marginTop: 8 }}>
            {STEPS.map((_, i) => <span key={i} style={theme.dot(i <= step)} />)}
          </div>
        </div>

        <div style={theme.body}>
          {step === 0 && (
            <div>
              <div style={theme.desc}>配置AI大模型，用于智能剪辑建议、脚本生成、字幕优化等功能。推荐使用DeepSeek。</div>
              <label style={theme.label}>服务商</label>
              <select style={theme.input} value={cfg.ai.provider} onChange={e => updateAI({ provider: e.target.value as AIProviderConfig['provider'] })}>
                <option value="none">未配置</option>
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="local">本地模型</option>
                <option value="custom">自定义</option>
              </select>
              {cfg.ai.provider !== 'none' && cfg.ai.provider !== 'local' && (
                <>
                  <label style={theme.label}>API Key</label>
                  <input style={theme.input} type="password" placeholder="sk-..." value={cfg.ai.apiKey} onChange={e => updateAI({ apiKey: e.target.value })} />
                </>
              )}
              <label style={theme.label}>接口地址</label>
              <input style={theme.input} placeholder="https://api.deepseek.com/v1" value={cfg.ai.endpoint} onChange={e => updateAI({ endpoint: e.target.value })} />
              <label style={theme.label}>模型名称</label>
              <input style={theme.input} placeholder="deepseek-chat" value={cfg.ai.model} onChange={e => updateAI({ model: e.target.value })} />
            </div>
          )}

          {step === 1 && (
            <div>
              <div style={theme.desc}>配置语音识别(ASR)，用于自动生成字幕。可跳过，后续在设置中配置。</div>
              <label style={theme.label}>服务商</label>
              <select style={theme.input} value={cfg.asr.provider} onChange={e => updateASR({ provider: e.target.value as ASRConfig['provider'] })}>
                <option value="none">未配置</option>
                <option value="bailian">阿里云百炼</option>
                <option value="whisper-local">Whisper本地</option>
                <option value="whisper-api">Whisper API</option>
                <option value="custom">自定义</option>
              </select>
              {cfg.asr.provider === 'bailian' && (
                <>
                  <label style={theme.label}>API Key</label>
                  <input style={theme.input} type="password" placeholder="sk-..." value={cfg.asr.apiKey} onChange={e => updateASR({ apiKey: e.target.value })} />
                  <label style={theme.label}>模型</label>
                  <select style={theme.input} value={cfg.asr.model || 'qwen-audio-3.0-asr-flash-streaming'} onChange={e => updateASR({ model: e.target.value })}>
                    <option value="qwen-audio-3.0-asr-flash-streaming">qwen-audio-3.0-asr-flash-streaming（推荐：Qwen-Audio3.0 实时，中英强、带回真实时间戳）</option>
                    <option value="qwen3-asr-flash-realtime">qwen3-asr-flash-realtime（Qwen3 实时，无原生时间戳）</option>
                    <option value="paraformer-realtime-v2">paraformer-realtime-v2（实时·词级时间戳，字幕对齐最准）</option>
                    <option value="fun-asr-realtime">fun-asr-realtime（实时）</option>
                  </select>
                  <label style={theme.label}>接口地址（可选）</label>
                  <input style={theme.input} placeholder="留空使用百炼默认地址" value={cfg.asr.endpoint} onChange={e => updateASR({ endpoint: e.target.value })} />
                </>
              )}
              {cfg.asr.provider === 'whisper-local' && (
                <>
                  <label style={theme.label}>模型路径</label>
                  <input style={theme.input} placeholder="./models/ggml-base.bin" value={cfg.asr.modelPath} onChange={e => updateASR({ modelPath: e.target.value })} />
                </>
              )}
              {cfg.asr.provider === 'whisper-api' && (
                <>
                  <label style={theme.label}>API Key</label>
                  <input style={theme.input} type="password" value={cfg.asr.apiKey} onChange={e => updateASR({ apiKey: e.target.value })} />
                </>
              )}
              {cfg.asr.provider === 'custom' && (
                <>
                  <label style={theme.label}>接口地址</label>
                  <input style={theme.input} value={cfg.asr.endpoint} onChange={e => updateASR({ endpoint: e.target.value })} />
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div style={theme.desc}>配置文字转语音(TTS)，用于AI配音生成。可跳过。Edge-TTS免费无需配置。</div>
              <label style={theme.label}>服务商</label>
              <select style={theme.input} value={cfg.tts.provider} onChange={e => updateTTS({ provider: e.target.value as TTSConfig['provider'] })}>
                <option value="none">未配置</option>
                <option value="edge-tts">Edge TTS（免费）</option>
                <option value="volcano">火山引擎</option>
                <option value="custom">自定义</option>
              </select>
              {cfg.tts.provider === 'volcano' && (
                <>
                  <label style={theme.label}>App ID</label>
                  <input style={theme.input} value={cfg.tts.appId} onChange={e => updateTTS({ appId: e.target.value })} />
                  <label style={theme.label}>Access Token</label>
                  <input style={theme.input} type="password" value={cfg.tts.accessToken} onChange={e => updateTTS({ accessToken: e.target.value })} />
                </>
              )}
              {cfg.tts.provider !== 'none' && (
                <>
                  <label style={theme.label}>默认音色</label>
                  <input style={theme.input} placeholder="zh-XiaoxiaoNeural" value={cfg.tts.defaultVoice} onChange={e => updateTTS({ defaultVoice: e.target.value })} />
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <div style={theme.desc}>配置完成！点击"完成"保存设置。你可以随时在设置中修改这些配置。</div>
              <div style={{ fontSize: 12, color: '#aaa', background: '#16213e', padding: 12, borderRadius: 4, lineHeight: 1.8 }}>
                AI大模型: {cfg.ai.provider === 'none' ? '未配置' : `${cfg.ai.provider} / ${cfg.ai.model}`}<br/>
                语音识别: {cfg.asr.provider === 'none' ? '未配置' : cfg.asr.provider}<br/>
                文字转语音: {cfg.tts.provider === 'none' ? '未配置' : cfg.tts.provider}<br/>
                渲染: {cfg.render.defaultResolution} @ {cfg.render.defaultFps}fps
              </div>
            </div>
          )}
        </div>

        <div style={theme.footer}>
          <div>
            {step > 0 && <button style={theme.btnGhost} onClick={prev}>上一步</button>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(step === 1 || step === 2) && <button style={theme.btnGhost} onClick={skip}>跳过</button>}
            {onCancel && <button style={theme.btnGhost} onClick={onCancel}>取消</button>}
            <button style={theme.btnPrimary} onClick={handlePrimary}>
              {canFinish ? '完成' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
