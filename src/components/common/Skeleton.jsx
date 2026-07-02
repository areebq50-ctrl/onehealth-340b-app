export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-gray-200 ${className}`} />;
}

export function SkeletonTable({ rows = 6, cols = 5 }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-gray-100 p-4">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="divide-y divide-gray-100">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-4 p-4">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCards({ count = 4 }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5">
          <Skeleton className="mb-3 h-4 w-24" />
          <Skeleton className="h-8 w-32" />
        </div>
      ))}
    </div>
  );
}
