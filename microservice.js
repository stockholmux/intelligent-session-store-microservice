const
  rk          = require('rk'),                                  // rk generates colon delimited keys
  argv        = require('yargs')                                // Handle command line arguments
              .demand('connection')                             // require passing `--connection` (which holds the JSON connection path object)
              .default('sessionglob','?*')                      // what part to handle, so multiple microservice instances can run together, sharing the load
              .argv,                                            // return just the arguments as a plain object
  redis       = require('redis'),                               // node_redis database library
  connection  = require(argv.connection),                       // Get the connection path (see: https://gist.github.com/stockholmux/23c992d33809b90791e00f7531a2ffac)
  rebloom     = require('redis-rebloom'),                       // bindings for the redis bloom filter  
  url         = require('url'),                                 // URL parser
  client      = redis.createClient(connection),                 // create the redis client object with the parameters from the connection configuration
  subClient   = client.duplicate(),                             // duplicate the client so we can subscribe and publish in the same script
  commands    = {},                                             // empty object to be populated
  baseTimeStamp
            = new Date(2018, 3, 1).getTime(),                   // starting point for the bit-based activity array
  db          = require('./db.module.node.js'); 

function minutesSinceBase() {                                   // helper function to get the number of minutes since the epoch
  return Math.floor((Date.now() - baseTimeStamp)/60000);
}
rebloom(redis);                                                 // give Redis bloom filter powers

function justThrowError(err) {                                  // stop repeating myself
  if (err) { throw err; }
}

subClient.on('pmessage', function (pattern,channel,message) {   // when we get a message 
  const
    channelParts    = channel.split(':'),                       // split apart the channel string
    requestId       = channelParts[3],                          // get the requestId from the 3rd array element
    sessionId       = channelParts[2],                          // get the sessionId from the 2nd array element
    command         = channelParts[1];                          // get the command from the 1st array element (0th is just 'ss' for session store)
  
  if (typeof commands[command] === 'function') {                // make sure we've registered a command for the one indiciated in the message
    commands[command](sessionId,requestId,message);             // run the command with the same signature: `sessionId`,`requestId` and the message
  } else {
    console.log(command, 'issued, but not implemented');        // if we don't have it registered, then just log a notification
  }
});
subClient.on('psubscribe', function(pattern) {                  // for debugging purposes only
  console.log('Subscribed to pattern',pattern);                 // just log it to the screen.
});

function asyncList(command,sessionId,requestId,data,cb) {       // post a response to a list
  let 
    asyncKey  = rk('async',command,sessionId,requestId);        // the key will look like `async:[command string]:[sessionId]:[requestId]
  
  client
    .multi()                                                    // transaction
    .lpush(asyncKey, JSON.stringify(data))                      // lpush at our key with the data passed in
    .pexpire(asyncKey,500)                                      // expire it in 500 ms 
    .exec(cb);                                                  // execute
}

commands.pageview = function(sessionId, requestId, passedUrl) { // this is run any time the microservice gets a 'pageview' message
  const
    pathname = url.parse(passedUrl).pathname,                   // get only the pathname from the URL 
    sessionAnalyticsMulti = client.multi(),                     // start a 'soft' transaction
    minuteOffset = minutesSinceBase();                          // calculate the minutes since the pre-defined base                 
  
  sessionAnalyticsMulti
    .pfadd(rk('sess-page-hll',sessionId),pathname)              // hyperloglog add - for unique page views
    .incr(rk('total-pages',sessionId))                          // increment the page counter
    .bitfield(rk('activity',sessionId),                         // use the activity bitcount field
      'GET','u1',minuteOffset,                                  // first get the u1 (binary) value at the minute offset
      'SET','u1',minuteOffset,'1')                              // then set the u1 (binary) value at the minute offset
    .bitfield(rk('activity',sessionId),                         // use the activity bitcount field
      'GET','u1',minuteOffset-5,                                // T-5 minutes activity
      'GET','u1',minuteOffset-4,                                // T-4 minutes activity
      'GET','u1',minuteOffset-3,                                // T-3 minutes activity
      'GET','u1',minuteOffset-2,                                // T-2 minutes activity
      'GET','u1',minuteOffset-1)                                // T-1 minutes activity (remember, 0 based)
    .pfcount(                                                   // counter the number of pages in the hyperloglog
      rk('sess-page-hll',sessionId)
    )
    .bf_add(                                                    
      rk('page-bloom',sessionId),                               // predefined key
      pathname                                                  // the path name only
    )
    .exec(function(err,results) {                               // execute the transaction
      if (err) { throw err; }                                   // since this is completely uncoupled, we can just can throw an error if something goes wrong - the microservice will go down, but the server will stay up
      asyncList(                                                // create the response list
        'pageview',                                             // with the command 'pageview'
        sessionId,                                              // the session...
        requestId,                                              // ...and request IDs
        {                                                       // the 'data' payload is the results from redis
          activityThisMinute  : results[2][0] === 1 ? true : false,
          totalPages          : results[1],
          activity            : results[3],
          uniquePages         : results[4],
          previouslyVisited   : results[5] === 1 ? false : true   // translate 0/1 for the page visit bloom filter to boolean
        },
        justThrowError                                          // did we get an error? just throw
      );
    });
};

function bloomAddPrimitive(key, asyncKeyPart) {                 // since this can repeat later, it's easier to express as a closure
  return function(sessionId, requestId, toAdd) {                // with the same signature as all the commands
    client.bf_add(                                              // add to a Bloom filter
      key(sessionId),                                           // the key function passed in and the sessionId is used to create a unique key
      toAdd,                                                    // data to add
      function(err) {                                           // callback
        if (err) { throw err; }                                 // handle the errors roughly - the microservice going down isn't the biggest deal since the server is now decoupled
        asyncList(                                              // send back the response
          asyncKeyPart,                                         // with the part passed in from the closure
          sessionId,                                            // the unique identifier for the session
          requestId,                                            // the unique identifier for this request
          toAdd,                                                // the value added
          justThrowError                                        // did we get an error? just throw
        );
      }
    );
  };
}
commands['mark-notification-seen'] = bloomAddPrimitive(         // see above
  function(sessionId) { return rk('notification',sessionId); },
  'mark-notification-seen'
);


function sumArray(arr) {                                        // helper function to sum an array of integers
  return arr.reduce((a, b) => a + b, 0);
}
commands.combo = function(sessionId, requestId) {               // on command 'combo'
  db.getFeaturedPages(                                          // get the featured pages from the mock database
    function(err,comboPages) {
      if (err) { throw err; }                                   // throw an error if encountered
      if (comboPages.length === 0) {                            // no combo pages?
        asyncList(                                              // create the response
          'combo',                                              // for the command combo
          sessionId,                                            // the unique identifier for the session
          requestId,                                            // the unique identifier for this request
          JSON.stringify([]),                                   // empty JSON array
          justThrowError                                        // did we get an error? just throw
        );
      } else {
        client.bf_mexists(                                      // we have combo pages
          rk('page-bloom',sessionId),                           // given the bloom filter for the session
          comboPages,                                           // pass in the combo pages as an array - node_redis is smart enough to apply each element individually
          function(err,results) {
            if (err) { throw err; }                             // did we get an error? just throw
            asyncList(                                          // create the response
              'combo',                                          // for the command combo
              sessionId,                                        // the unique identifier for the session           
              requestId,                                        // the unique identifier for this request
              Number(sumArray(results) === comboPages.length),  // 1 or 0
              justThrowError                                    // did we get an error? just throw
            );
          }
        );
      }
    }
  );
};


function onlyNotFoundInBloomFilter(arr,filterKey,cb) {          // Get the items that are *not* found in the bloom filter (inversion)
  if (arr.length === 0) {                                       // if we have nothing in the notification array...
    cb(null,arr);                                               // then everything is unread :)
  } else {
    client.bf_mexists(                                          // check if multiple items exist
      filterKey,                                                // our bloom filter key
      arr,                                                      // and our item's were checking against
      function(err,existsArr) {                                 
        if (err) { cb(err); } else {                            // check to see if we have an error and that error is not that it doesn't exist
           cb(
            err,                                                // this will be null/falsey
            arr.filter(function(el,index) {                     // filter out non existent items from the bloom filter
              return existsArr[index] === 0;
            })
          );
        }
      }
    );
  }
}

commands.notifications = function(sessionId, requestId, notificationsJSONArray) { // on command 'notifications'
  let notifications = JSON.parse(notificationsJSONArray);
  onlyNotFoundInBloomFilter(                              // Return the items that are not in the bloom filter given an array
    notifications,                                        // parsed JSON
    rk('notification',sessionId),                         // bloom filter key notification:[sessionId]
    function(err,filteredArr) {                           // returns an array
      if (err) { throw err; }                             // did we get an error? just throw
      notifications = notifications
        .map(function(aNotification) {                    // map over the notifications
          return  {                                       // returning an object for each array element
            text    : aNotification,                      // always return the next of the notification                
            seen    : filteredArr                         // seen is determined if it's in eliminated notification array
              .indexOf(aNotification) >= 0 ? true : false,
            link    : '?seen='+aNotification              // the link is just the same page with the query string
          };
        });
        asyncList(                                        // create the response
          'notifications',                                // for the command 'notifications'
          sessionId,                                      // the unique identifier for the session
          requestId,                                      // the unique identifier for this request
          JSON.stringify(notifications),                  // JSON as the payload
          justThrowError                                  // did we get an error? just throw
        );
    }
  );
};

commands.featuredpages = function(sessionId, requestId, featuredPagesJSONArray) { // on command 'featuredpages'
  let featuredPages = JSON.parse(featuredPagesJSONArray); // parse out the passed string to JSON
  if (featuredPages.length === 0) {                       // we don't have any featured pages?
    asyncList(                                            // send out the response 
      'featuredpages',                                    // ..on the command 'featuredpages'
      sessionId,                                          // the unique identifier for the session
      requestId,                                          // the unique identifier for this request
      JSON.stringify([]),                                 // empty array
      justThrowError                                      // did we get an error? just throw
    );
  } else {
    onlyNotFoundInBloomFilter(                            // Return the items that are not in the bloom filter given an array
      featuredPages,                                      // the parsed response as the list to check against
      rk('page-bloom',sessionId),                         // the key would look like "page-bloom:[sessionId]"
      function(err,pages) { 
        if (err) { throw err; }                           // did we get an error? just throw
        asyncList(                                        // send the response
          'featuredpages',                                // with the commands 'featuredpages'
          sessionId,                                      // the unique identifier for the session
          requestId,                                      // the unique identifier for this request
          JSON.stringify(pages),                          // JSON as the payload
          justThrowError                                  // did we get an error? just throw
        );
      }
    )
  }
};

console.log('Glob pattern:',argv.sessionglob);            // echo which pattern we're watching

Object.keys(commands).forEach(function(aCommand) {        // iterate through the commands
  let subPattern = rk('ss',aCommand,argv.sessionglob,'?*'); // create a subscription pattern including the passed in sessionglob
  subClient.psubscribe(subPattern, function(err,pattern) {// subscribe to the pattern with the pattern
    if (err) { throw err; }                               // did we get an error? just throw
  });  
});