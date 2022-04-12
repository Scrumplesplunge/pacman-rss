const feedUpdatePeriodMinutes = 10;

// Set of URIs for each RSS feed.
var subscriptions = new Set;

// Map from channel url to sets of GUIDs which the user has dismissed. This is
// not exhaustative; it only mentions GUIDs of entries which are still present
// in the live feeds. While this might technically result in things reappearing
// for the user if a channel removes and subsequently restores an item in their
// feed, I don't expect this to be a problem.
var dismissed = new Map;

// Promise for the most recent cache of items for the RSS feed, keyed by GUID.
var feedCache = {time: 0};

function loadStorage() {
  subscriptions = new Set(JSON.parse(localStorage.subscriptions || '[]'));
  var rawDismissed = JSON.parse(localStorage.dismissed || '[]');
  dismissed = new Map(rawDismissed.map(([k, vs]) => [k, new Set(vs)]));
  var rawFeedCache =
      JSON.parse(localStorage.feedCache || '{"time":0,"items":[]}');
  feedCache = {time: rawFeedCache.time, items: new Map(rawFeedCache.items)};
}
loadStorage();

function saveStorage() {
  localStorage.subscriptions = JSON.stringify([...subscriptions]);
  localStorage.dismissed =
      JSON.stringify([...dismissed].map(([k, vs]) => [k, [...vs]]));
  localStorage.feedCache = JSON.stringify(
      {time: feedCache.time, items: [...feedCache.items.entries()]});
}

// Get the text contents of a single XML node.
function text(xml, path) {
  var root = xml.ownerDocument || xml;
  var node = root.evaluate(path, xml).iterateNext();
  if (node == null)
    throw new Error("No such path " + path + " in XML document.");
  if (node.childNodes.length != 1) {
    throw new Error("Path " + path +
                    " has multiple children when it should only contain text.");
  }
  if (node.childNodes[0].nodeType == Node.TEXT_NODE ||
      node.childNodes[0].nodeType == Node.CDATA_SECTION_NODE) {
    return node.childNodes[0].nodeValue;
  } else {
    throw new Error("Path " + path + " does not contain a text node.");
  }
}

// Fetch the XML data from a single RSS feed.
async function fetchFeed(uri) {
  var response = await fetch(uri);
  if (response.status != 200) throw new Error("HTTP " + response.status);
  var parser = new DOMParser;
  var xml = parser.parseFromString(await response.text(), "application/xml");
  if (xml.firstElementChild.nodeName != "rss")
    throw new Error("Response is not an RSS document.");
  var result = {
    title: text(xml, "rss/channel/title"),
    link: text(xml, "rss/channel/link"),
    description: text(xml, "rss/channel/description"),
    items: [],
  };
  for (var item of xml.getElementsByTagName("item")) {
    result.items.push({
      title: text(item, "title"),
      link: text(item, "link"),
      description: text(item, "description"),
      pubDate: text(item, "pubDate"),
      guid: text(item, "guid"),
    });
  }
  return result;
}

// Refresh all subscribed feeds.
async function fetchFeeds() {
  console.log("Fetching feeds..");
  var rawFeeds = [...subscriptions].map(x => fetchFeed(x).then(y => [x, y]));
  var feeds = new Map(await Promise.all(rawFeeds));
  var items = new Map;
  for (var [url, feed] of feeds) {
    var channelDismissed = dismissed.get(url) || new Set;
    var seen = new Set;
    for (var item of feed.items) {
      seen.add(item.guid);
      if (channelDismissed.has(item.guid)) continue;
      items.set(item.guid, {
        feed: url,
        guid: item.guid,
        title: item.title,
        link: item.link,
        description: item.description,
        pubDate: item.pubDate,
      });
    }
    // Remove from the dismissal set any items which no longer appear in the
    // live feed. This prevents the dismissal set from growing indefinitely and
    // will work as intended unless channels do weird things like removing and
    // readding the same items.
    for (var x of channelDismissed) {
      if (!seen.has(x)) {
        channelDismissed.delete(x);
      }
    }
  }
  return items;
}

async function updateBadge() {
  var items = feedCache.items;
  chrome.browserAction.setBadgeText(
          {text: items.size > 0 ? items.size.toString() : ''});
}

async function refreshFeed() {
  console.log("Refreshing feed...");
  var items = await fetchFeeds();
  feedCache.time = Date.now();
  feedCache.items = items;
  saveStorage();
  await updateBadge();
  return items;
}

async function getFeeds(forceRefresh) {
  var cacheAge = Date.now() - feedCache.time;
  var willRefresh = forceRefresh || cacheAge > feedUpdatePeriodMinutes * 60000;
  if (!willRefresh) {
    console.log('Reusing cache (age: ' + cacheAge / 1000 + 's)');
  }
  var itemMap = willRefresh ? await refreshFeed() : feedCache.items;
  var items = [...itemMap.values()];
  items.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
  return items;
}

// Display a notification with the given text.
function notify(message) {
  chrome.notifications.create(
      {type: 'basic', iconUrl: 'icon.png', title: 'Pacman RSS', message});
  console.log(message);
}

// Async wrapper for requesting permissions.
function getPermissions(permissions) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request(
        permissions, granted => granted ? resolve() : reject());
  });
}

// Generate a canonical URL to request permissions for given the URL for a feed.
function canonicalUri(uri) {
  var url = new URL(uri);
  return "*://*." + url.hostname.replace(/^www\./, "") + "/*";
}

// Subscribe to the given uri.
async function subscribe(uri) {
  await getPermissions({origins: [canonicalUri(uri)]});
  if (subscriptions.has(uri)) {
    notify("Already subscribed to " + uri);
  } else {
    subscriptions.add(uri);
    saveStorage();
    notify("Subscribed to " + uri);
    await refreshFeed();
  }
}

chrome.runtime.onStartup.addListener(function() {
  console.log("Started");
});

chrome.alarms.create('refreshFeed', {periodInMinutes: feedUpdatePeriodMinutes});
chrome.alarms.onAlarm.addListener(function(alarm) {
  switch (alarm.name) {
    case "refreshFeed": return refreshFeed();
  }
});
refreshFeed();

async function dismiss(guid) {
  // Add the item to the relevant dismissal list.
  if (!feedCache.items.has(guid)) {
    throw new Error("Dismissing an untracked item.");
  }
  var item = feedCache.items.get(guid);
  if (!dismissed.has(item.feed)) dismissed.set(item.feed, new Set);
  dismissed.get(item.feed).add(guid);
  feedCache.items.delete(guid);
  saveStorage();

  await updateBadge();
}

chrome.runtime.onMessage.addListener(function(message, sender, respond) {
  switch (message.type) {
    case "dismiss": return dismiss(message.guid);
    case "getFeeds": getFeeds(message.forceRefresh).then(respond); return true;
    case "subscribe": return subscribe(message.uri);
  }
});

chrome.contextMenus.onClicked.addListener(function(info, tab) {
  switch (info.menuItemId) {
    case "subscribe": return subscribe(info.linkUrl);
  }
});

chrome.runtime.onInstalled.addListener(function() {
  chrome.contextMenus.create({
    id: 'subscribe',
    contexts: ['link'],
    title: 'Subscribe to RSS feed',
  });
});
