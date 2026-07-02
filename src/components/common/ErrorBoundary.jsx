import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`ErrorBoundary [${this.props.label ?? 'component'}] caught:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-200 bg-red-50 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-danger" />
            <h3 className="text-base font-semibold text-navy">
              {this.props.label ? `${this.props.label} failed to load` : 'Something went wrong'}
            </h3>
            <p className="max-w-md text-sm text-gray-600">
              This section hit an unexpected error. The rest of the app is unaffected — try refreshing, or contact
              an administrator if this keeps happening.
            </p>
            <button className="btn-secondary" onClick={() => this.setState({ hasError: false, error: null })}>
              Try again
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
