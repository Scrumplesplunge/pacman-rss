var subscribeButton = document.getElementById('subscribe');
var refreshButton = document.getElementById('refresh');
var expandForm = document.getElementById('expandForm');
var expandButton = document.getElementById('expand');
var articlesBox = document.getElementById('articles');
var loadingSpinner = document.getElementById('loadingSpinner');
var emptyMessage = document.getElementById('emptyMessage');

// Format an article.
function addArticle(options) {
  var article = document.createElement('article');
  articlesBox.appendChild(article);

  var dismissButton = document.createElement('button');
  article.appendChild(dismissButton);
  dismissButton.appendChild(document.createTextNode('🗙'));
  dismissButton.addEventListener(
      'click', event => dismiss(article, options.guid));

  var link = document.createElement('a');
  link.href = options.link;
  link.target = '_blank';
  article.appendChild(link);

  var header = document.createElement('h1');
  header.appendChild(document.createTextNode(options.title));
  link.appendChild(header);

  var time = document.createElement('time');
  article.appendChild(time);
  time.dateTime = options.pubDate;
  var pubDate = new Date(options.pubDate);
  time.appendChild(document.createTextNode(pubDate.toLocaleString()));

  article.appendChild(document.createElement('br'));

  var preview = document.createElement('iframe');
  // Treat the content as same-origin but don't allow scripts to run. This seems
  // like a reasonable compromise but I'm simply waiting to be proven wrong.
  preview.sandbox = 'allow-same-origin allow-popups';
  article.appendChild(preview);
  preview.onload = () => {
    preview.style.height =
        `${preview.contentWindow.document.body.scrollHeight}px`;
  };
  preview.contentWindow.document.open();
  preview.contentWindow.document.write(`
      <!doctype html>
      <title>Preview</title>
      <base href="http://www.example.com/"
      <base target="_blank">
      <style>
        html, body { margin: 0; padding: 0; width: 100%; overflow: hidden; }
        img, video { max-width: 100%; }
      </style>`);
  preview.contentWindow.document.write(options.description);
  preview.contentWindow.document.close();
}

// Convenience for allowing `await delay(100)` for sleeping in async functions.
function delay(ms) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

// Dismiss the given article: no longer show it in the feed.
async function dismiss(article, guid) {
  chrome.runtime.sendMessage({type: 'dismiss', guid});
  article.style.height = getComputedStyle(article).height;
  article.classList.add('remove');
  await delay(100);
  console.log(`Removing article ${guid}`);
  article.remove();
  if (articlesBox.childNodes.length == 0) {
    emptyMessage.style.display = 'block';
  }
}

// Prompt for a URI to subscribe to. This is an alternative to right-clicking
// a link.
async function subscribe() {
  var uri = prompt('Enter an RSS feed URI');
  chrome.runtime.sendMessage({type: 'subscribe', uri});
}
subscribeButton.addEventListener('click', subscribe);

// Asynchronously fetch the JSON representations of each feed item to show. If
// forceRefresh is true, this will perform a fresh request to each feed to find
// new content. If it is false, the last cached version will be used.
function getFeeds(forceRefresh) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type: 'getFeeds', forceRefresh}, response => {
      response === undefined ? reject() : resolve(response);
    });
  });
}

// Call getFeeds and update the window accordingly.
async function refresh(forceRefresh) {
  console.log('Clearing articles.');
  while (articlesBox.lastChild) articlesBox.removeChild(articlesBox.lastChild);
  emptyMessage.style.display = 'none';
  loadingSpinner.style.display = 'block';
  var items = await getFeeds(forceRefresh);
  loadingSpinner.style.display = 'none';
  if (items.length == 0) {
    emptyMessage.style.display = 'block';
  } else {
    items.forEach(addArticle);
  }
}
refreshButton.addEventListener('click', () => refresh(forceRefresh = true));
refresh(forceRefresh = false);

expandButton.addEventListener('click', () => expandForm.submit());
