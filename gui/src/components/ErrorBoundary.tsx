// 错误边界：隔离单个子树（如预览画布）的渲染崩溃，避免一次 GPU/JS 异常导致整窗黑屏。
// 配合「连续拖动走 live（不每帧深拷贝）」修复，进一步降低黑屏风险。
import React from 'react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 仅记录，不向上抛出（避免整窗崩溃）
    console.error('[ErrorBoundary] 已隔离渲染异常，防止整窗黑屏:', error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, background: '#1a1a2e', color: '#eee', fontFamily: 'system-ui' }}>
          <div style={{ fontSize: 14, color: '#e94560', fontWeight: 600 }}>{this.props.fallbackTitle || '该区域发生异常'}</div>
          <div style={{ fontSize: 11, color: '#aaa', maxWidth: 360, textAlign: 'center', wordBreak: 'break-word' }}>
            {this.state.error.message || String(this.state.error)}
          </div>
          <button
            onClick={this.handleReset}
            style={{ background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
