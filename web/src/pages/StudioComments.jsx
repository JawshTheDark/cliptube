import { Link } from 'react-router-dom';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { HeldComments } from './AdminModeration.jsx';

/** Comments held for review on the signed-in person's own videos. */
export default function StudioComments() {
  useTitle('Comments to review');
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>
          <Icon name="hourglass" /> Comments to review
        </h1>
        <Link to="/studio" className="btn btn-ghost">
          <Icon name="back" /> Studio
        </Link>
      </div>
      <p className="page-sub flush">
        Comments that spam checks, your blocked words or your review setting held back. Approve them to publish, or delete them. Change what gets held in{' '}
        <Link to="/settings">Settings</Link>.
      </p>
      <HeldComments endpoint="/me/comments/held" />
    </div>
  );
}
