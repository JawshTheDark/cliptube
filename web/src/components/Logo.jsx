import { Link } from 'react-router-dom';

/** Two overlapping circles with a play button: the OurTube mark. */
export function LogoMark({ size = 30 }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="21" cy="16" r="9" fill="currentColor" opacity="0.45" />
      <circle cx="13" cy="16" r="11" fill="currentColor" />
      <path d="M10 11.2v9.6l7.6-4.8z" fill="#fff" />
    </svg>
  );
}

/** The mark and the server's name; a server still called OurTube gets the two-tone wordmark. */
export function Logo({ name, onClick }) {
  const ours = /^\s*ourtube\s*$/i.test(name || '');
  return (
    <Link to="/" className="logo" onClick={onClick}>
      <LogoMark />
      <span className="logo-text">
        {ours ? (
          <>
            <span className="logo-our">our</span>tube
          </>
        ) : (
          name
        )}
      </span>
    </Link>
  );
}
