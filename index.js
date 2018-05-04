'use strict';

const { createLogger } = require('bunyan');
const { writeFileSync } = require('fs');
const waterfallize = require('waterfallize');
const errTo = require('errto');
const RedditClient = require('reddit-api-client');
const commentStream = require('./lib/stream-top-level-cmts');
const { name, version } = require('./package.json');
const isDebugEnabled = require('enabled')(name);

require('app-title')();

let opts = Object.assign({}, process.env);

try {
  opts = Object.assign(opts, require('./redrc.json'));
} catch (e) {
  // ignore err
}

opts.REDDIT_PASS = new Buffer(opts.REDDIT_PASS, 'base64').toString('utf8');

const r = new RedditClient({
  redditKey: opts.REDDIT_KEY,
  redditSecret: opts.REDDIT_SECRET,
  redditUser: opts.REDDIT_USER,
  redditPass: opts.REDDIT_PASS,
  redditUserAgent: opts.REDDIT_USER_AGENT
});

const log = createLogger({
  name: `${name}@${version}`,
  level: isDebugEnabled ? 'debug' : 'error'
});

log.addSerializers({
  comments: (comments) => {
    if (!comments || !comments.length) {
      return comments;
    }

    return comments.map(c => ({
      id: c.id,
      author: c.author,
      body: c.body
    }));
  }
})

const sub = 'fifa';

const getDstId = (cb) => {
  r.get(`/r/${sub}`, {
    query: {
      limit: 2
    }
  }, errTo(cb, (res) => {
    const dstThread = res.body.data.children
                        .find(t => /daily squad thread/ig.test(t.data.title));
    const { id } = dstThread.data;

    cb(null, id);
  }));
};

const replyToComment = (id, cb) => {
  let text = 'Prices depend on the platform, so make sure to edit your message ';
  text += 'and include it. ';
  text += 'This is an automated message so don\'t reply to it.';

  const replyOpts = {
    payload: {
      api_type: 'json',
      text: text,
      thing_id: `t1_${id}` // reply to comment
      // thing_id: 't3_<ID>' // reply to post
    }
  };

  if (isDebugEnabled) {
    return setImmediate(cb);
  }

  r.post(`/api/comment`, replyOpts, cb);
}


const fail = (msg) => (err) => {
  const logMessage = msg ? `Error: ${msg}` : err.toString();

  log.error({ err }, logMessage);

  process.exit(1);
};

let processedComments = {};

const getProcessedFileById = (id) => `${__dirname}/data/${id}.json`;
const getProcessedContent = (id) => {
  let res = processedComments[id] || [];

  if (res.length) { return res; }

  try {
    log.debug(
      `Get already processed posts from file ${getProcessedFileById(id)}`
    );

    res = require(getProcessedFileById(id));
  } catch (e) {
    // ignored
  }

  return res;
};

const getProcessedComments = (id) => {
  if (processedComments[id] && processedComments[id].length) {
    return processedComments[id];
  }

  return getProcessedContent(id);
};

const processComments = (id, alreadyProcessed, comments) => {
  log.debug({ comments }, 'comments retrieved');

  const cmts = comments.filter(t => !(/(ps(\s)?3|ps(\s)?4|xb|pc)/ig.test(t.body)));

  const toBeProcessed = cmts.filter(c => !alreadyProcessed.includes(c.id));
  const nextCycle = () => setTimeout(processTopLevelComments, 60 * 1000 * 2);

  if (!toBeProcessed.length) { return nextCycle(); }

  log.debug({ comments: toBeProcessed }, 'comments to be replied to');


  const next = waterfallize();
  processedComments[id] = alreadyProcessed;

  toBeProcessed.forEach(c => {
    next(cb => {
      log.info(`replying to comment ${c.id}`);

      replyToComment(c.id, errTo(cb, () => {
        processedComments[id].push(c.id);
        writeFileSync(getProcessedFileById(id), JSON.stringify(processedComments[id], null, 2));

        setTimeout(() => cb(), 10000);
      }));
    });
  });

  next((err) => {
    if (err) {
      log.error({ err }, 'error replying to comment');
    }

    nextCycle();
  });
};

const processTopLevelComments = () => {
  getDstId(errTo(fail('cannot retrieve current DST id'), (id) => {
    const alreadyProcessed = getProcessedComments(id);

    commentStream({ r, id, sub })
      .on('data', processComments.bind(null, id, alreadyProcessed))
      .on('error', fail('processTopLevelComments stream failure'))
      .on('end', () => log.debug('finished comments retrieval'));
  }));
};

processTopLevelComments();
