import { Link } from 'react-router-dom';
import { useAuth, useTitle } from '../auth.jsx';

/** Public help: following OurTube channels from Mastodon and PeerTube, and moving a channel. */
export default function HelpFediverse() {
  const { site, user } = useAuth();
  useTitle('Following from the fediverse');
  const host = site.ap_host || window.location.host;
  const name = user?.username || 'name';
  return (
    <div className="page page-narrow help-page">
      <h1>Following from the fediverse</h1>
      {site.activitypub === false && <div className="notice warn-box">This site has ActivityPub turned off right now, so the steps below won&rsquo;t work here.</div>}
      <p>
        {site.site_name} speaks ActivityPub, the language Mastodon, PeerTube and the rest of the fediverse use. People there can follow channels here without an
        account, and people here can follow channels there.
      </p>

      <h2>From Mastodon (and GoToSocial, Misskey, Pleroma…)</h2>
      <ol>
        <li>
          Search for the account, like <code>@{name}@{host}</code>, and press Follow. Or open the channel here, go to its <b>About</b> tab, type your server
          under <b>On the fediverse</b> and press <b>Follow from there</b>.
        </li>
        <li>New clips show up in your home timeline with the title and a playable video.</li>
        <li>Replies become comments under the video here, favourites count as likes, and boosts count as shares.</li>
      </ol>

      <h2>From PeerTube</h2>
      <ol>
        <li>
          Search for the channel, like <code>@{name}_channel@{host}</code>, or paste the channel&rsquo;s link into PeerTube&rsquo;s search.
        </li>
        <li>PeerTube plays the videos from here; comments and likes come back the same way.</li>
        <li>
          PeerTube admins can follow this whole site: follow <code>
            @{host}@{host}
          </code>{' '}
          from the instance follows page.
        </li>
      </ol>

      <h2>Following fediverse channels from here</h2>
      <p>
        Open <Link to="/subscriptions">Subscriptions</Link> and use <b>Follow from the fediverse</b> with a handle or a link. Their new videos join your
        subscriptions, and you can like and comment on them here.
      </p>

      <h2>Moving a channel to another site</h2>
      <ol>
        <li>
          On the old site: <Link to="/settings/account#move">Settings → Moving to another site</Link> → <b>Export channel</b>, then copy its private link.
        </li>
        <li>On the new site: paste the link under <b>Import a channel here</b>. Videos, comments, captions and the profile come along.</li>
        <li>On the new site: add the old account under <b>Moving here</b>.</li>
        <li>
          On the old site: enter the new account under <b>Moving away</b>. Subscribers here, on other OurTube servers and on Mastodon or PeerTube are moved to
          the new channel, and the old channel points there.
        </li>
      </ol>

      <h2>What stays here</h2>
      <p>Private and unlisted videos, and videos with &ldquo;share with the network&rdquo; turned off, are never sent to other servers.</p>
    </div>
  );
}
