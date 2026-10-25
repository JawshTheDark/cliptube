# Moderation and Legal

Moderation tools are under **Admin → Moderation** (moderators and admins); legal settings are under
**Admin → Legal** (admins).

- [Roles](#roles)
- [Reports](#reports)
- [Hiding and removing videos](#hiding-and-removing-videos)
- [Comments and spam](#comments-and-spam)
- [Sign-up](#sign-up)
- [Storage quotas](#storage-quotas)
- [Copyright notices](#copyright-notices)
- [Public pages](#public-pages)
- [Privacy](#privacy)
- [Background, not legal advice](#background-not-legal-advice)

## Roles

| Role | Can |
| --- | --- |
| **Member** | Upload, comment, like, subscribe, report |
| **Moderator** | Everything a member can, plus reports, held comments, hiding and removing videos, suspending members, and the game catalog |
| **Admin** | Everything, including site settings, the network and legal |

Change a role in the users table (Admin → Overview → Users) or from the command line:

```bash
docker exec cliptube node server/cli.js user role alice moderator
```

## Reports

Signed-in people can flag a video, a comment or a channel, including ones from other servers. Reports about
another server's content are forwarded to it, so its moderators see them in their own queue. Each report has
one-click actions and notes, and every action lands in the **audit log**.

## Hiding and removing videos

- **Hide**: only the uploader and moderators can see it.
- **Remove**: nobody can play it. The files are kept for the retention period set in Admin → Legal (30 days by
  default, in case of a counter-notice), then deleted.

## Comments and spam

- A person's **first comments**, **links from new accounts** and **names that imitate the uploader** are held
  for review, and fast posting is **rate limited**. The thresholds are in Admin → Moderation → *Spam settings*
  (see [Configuration](Configuration.md#admin--moderation)).
- Uploaders can add **blocked words**, hold every comment, turn comments off per video, and **pin** or
  **heart** comments.
- Held comments stay visible to their author, marked as held, and wait in Studio → *Comments* for review.

## Sign-up

| Mode | What happens |
| --- | --- |
| **Open** | Anyone can create an account |
| **Approval** | New accounts wait until an admin approves them in the users table |
| **Invite** | Only people with an invite link can join; links can have a use limit and an expiry |
| **Closed** | No new accounts |

An invite also skips approval. If you write terms in Admin → Legal, people accept them when they sign up. For a
server for friends, invite-only is a good default.

## Storage quotas

Set a default quota per person in Admin → Overview (0 means no limit), and override it per person in the users
table.

## Copyright notices

Record each notice in **Admin → Legal**. Choosing *Remove the video* takes it down and, optionally, gives the
uploader a **strike**; enough active strikes (3 by default, each lasting a year) suspend the account. The
uploader can send a **counter-notice** from the removed video, and accepting it restores the video and takes the
strike away.

## Public pages

- `/legal` shows your rules, terms and contacts.
- `/transparency` shows counts of notices, removals and restorations. You can turn it off.

## Privacy

People can pause their watch history, use anonymous mode in a browser, download all of their data, and delete
their account after a 7-day grace period. See [Watching and Discovery](Watching-and-Discovery.md#privacy).

## Background, not legal advice

If strangers can upload to your server, you are hosting their content. Laws differ by country, so talk to a
lawyer before opening sign-ups. For the US, the short version:

- **DMCA safe harbor (17 U.S.C. § 512(c))** protects hosts from copyright claims over user uploads if they
  register a designated agent with the US Copyright Office (an online form with a small fee, renewed every three
  years), remove material quickly when they get a valid notice, and have and enforce a policy that ends repeat
  infringers' accounts. Put the agent's details in Admin → Legal so they show on `/legal`.
- **Counter-notices.** After a valid counter-notice, the law expects the host to put the material back in 10 to
  14 business days unless the claimant says they have gone to court. ClipTube records the counter-notice and
  leaves the decision to you.
- **Section 230** generally shields hosts from liability for what users post, but not for copyright or federal
  crimes. Child sexual abuse material must be reported to NCMEC; remove it and preserve what you're told to.
- **Elsewhere**, the EU's Digital Services Act has its own notice-and-action and transparency rules for hosts.

Running a members-only server for friends keeps most of this simple. Use invite-only sign-up until you're ready
for more.
