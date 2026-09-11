"use client";

import React, { Component } from "react";
import { AlertCircle, RefreshCw } from "@/shared/components/ui/Icon";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[ErrorBoundary caught error]:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return typeof this.props.fallback === "function"
          ? this.props.fallback(this.state.error, this.handleReset)
          : this.props.fallback;
      }

      return (
        <div className="w-full h-full min-h-[160px] flex flex-col items-center justify-center p-6 text-center select-none bg-surface/50 border border-border-subtle/40 rounded-brand m-2">
          <AlertCircle size={24} className="text-danger mb-2" />
          <div className="text-sm font-semibold text-text mb-1">
            {this.props.title || "Something went wrong in this pane"}
          </div>
          <div className="text-xs text-text-muted font-mono max-w-md truncate mb-4">
            {this.state.error?.message || "Render error"}
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="px-3 py-1.5 rounded bg-surface-2 hover:bg-surface-3 text-text text-xs flex items-center gap-1.5 font-medium transition-colors border border-border-subtle"
          >
            <RefreshCw size={12} />
            <span>Try again</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
export default ErrorBoundary;
