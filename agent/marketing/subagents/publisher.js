// Publisher sub-agent. Wraps Meta API calls. Does NOT generate copy.
// Pure executor: takes an approved post row, ships it to FB or IG, records the result.

import * as meta from '../meta.js';
import { getPost, markPostPublished, markPostFailed, setPostStatus } from '../memory.js';

export async function publishPost(postId) {
  const post = getPost(postId);
  if (!post) throw new Error(`Post #${postId} not found`);
  if (!['approved', 'scheduled'].includes(post.status)) {
    throw new Error(`Post #${postId} status is ${post.status} — cannot publish`);
  }
  if (!meta.isConfigured()) {
    markPostFailed(postId, 'Meta API not configured (missing META_PAGE_TOKEN)');
    throw new Error('Meta API not configured');
  }

  setPostStatus(postId, 'publishing');
  try {
    let result;
    if (post.platform === 'facebook') {
      result = await meta.postToFacebookPage({ message: post.caption, imageUrl: post.image_url });
    } else if (post.platform === 'instagram') {
      result = await meta.postToInstagram({ caption: post.caption, imageUrl: post.image_url });
    } else {
      throw new Error(`Unknown platform: ${post.platform}`);
    }
    markPostPublished(postId, { external_id: result.id, permalink: result.permalink });
    return { ok: true, ...result };
  } catch (err) {
    markPostFailed(postId, err.message);
    throw err;
  }
}

export function schedulePost(postId, scheduledAtIso) {
  setPostStatus(postId, 'scheduled');
  // scheduled_at is set by caller via createPost; nothing else to do here.
  return { postId, scheduledAt: scheduledAtIso };
}
