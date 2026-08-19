import { Component, type ErrorInfo, type ReactNode } from 'react';
import { setLastOpenedId } from '../engine/projectStore';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

/**
 * 描画中の例外でアプリ全体が消えないようにする。
 *
 * React は例外を捕まえないとツリーごと外すので、画面が真っ暗になって
 * 何が起きたか分からなくなる。しかも原因が保存データ側にあると、
 * 読み込み直しても同じところで落ちて詰んでしまう。
 * ここで受け止めて、保存データを読まずにやり直す道を用意する。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('描画中に問題が起きました', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;

    return (
      <div className="crash">
        <h1>問題が起きて、画面を表示できませんでした</h1>
        <p>
          申し訳ありません。下のボタンでやり直せます。
          保存したプロジェクトは消えません。
        </p>

        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => {
              // 保存データが原因のこともあるので、復元せずに開き直す
              void setLastOpenedId(null).finally(() => window.location.reload());
            }}
          >
            復元せずに開き直す
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            そのまま再読み込み
          </button>
        </div>

        <p className="crash__detail">{this.state.message}</p>
      </div>
    );
  }
}
