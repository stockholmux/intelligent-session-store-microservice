const 
  argv        = require('yargs')                                    // Handle command line arguments
              .demand('connection')                                 // require passing `--connection` (which holds the JSON connection path object)
              .argv,                                                // return just the arguments as a plain object
  async       = require('async'),                                   // Async flow control library
  redis       = require('redis'),                                   // node_redis database library
  connection  = require(argv.connection),                           // Get the connection path (see: https://gist.github.com/stockholmux/23c992d33809b90791e00f7531a2ffac)
  rk          = require('rk'),                                      // rk generates colon delimited keys
  express     = require('express'),                                 // node.js server framework
  session     = require('express-session'),                         // Session add-on for express.js - in this example, we're using it mostly to generate session IDs
  
  RedisStore  = require('connect-redis')(session),                  // connect router redis for session storage
  cuid        = require('cuid'),                                    // generate a randomized string of characters

  app         = express(),                                          // instantiate the server
  client      = redis.createClient(connection),                     // create the redis client object with the parameters from the connection configuration
  db          = require('./db.module.node.js');                     // "Dummy" database (actually constants)


app.set('view engine', 'pug');                                      // we're using the jade/pug rendering engine

app.use(                                                            // app use to set a middleware
  session({                                                         // inject the session management middlewear
    resave              : false,                                    // this module can re-save any changed session from req.session, but it has some problems so we're turning this feature off
    saveUninitialized   : true,                                     // related to above
    secret              : 'hello white-paper',                      // used to generate your session ID, should be constant yet different between app
    store               : new RedisStore({                          // instantiate the RedisStore object
      client  : client.duplicate()                                  // give it the specified connection
    })
  })
);
app.use(function(req,res,next) {                                    // on every request, we inject a unique request and publish a page view item
  req.requestId = cuid();                                           // the unique request ID
  client.publish(
    rk('ss','pageview',req.sessionID,req.requestId),                // the key based on both the request and session ID
    req.path                                                        // the message is the path of the request
  );
  next();
});
app.use('/static',express.static('static'));                        // static file server for CSS, etc


function sessionDone(cmd,dest,returnFalse,req,cb) {                 // when the session work is done, this will return back to the callback
  const
    blockClient = client.duplicate();                               // We'll be using blocking commands and we want to continue to do other stuff during this block so we need to duplicate.
                                                                    // For simplicity in this demo, we're creating a connection for each new response, however this a case for pooling in production
                                                                    // as creating a client is expensive for both Redis and Node.js
  blockClient.blpop(                                                // blocking left pop
    rk('async',cmd,req.sessionID,req.requestId),                    // rk:[cmd]:[sessionId]:[requestId]
    1,                                                              // block for 1 second, although we will stop this before it ever gets here
    function(err,response) {                                        // error first callback
      blockClient.quit();                                           // immediately quit the blocking client (in production you would return it back to the pool)
      if (err) { cb(err); } else {                                  // handle the error
        if (response) {                                             // if you have a response
          try {                                                     // since JSON.parse can fail and it's not async, we need to catch it.
            req[dest] = JSON.parse(response[1]);                    // parse the response for the relevant part
          } catch(e) { 
            req[dest] = response[1];                                // if we can't parse the JSON, so we just return back the raw value
          }
        } else {
          req[dest] = returnFalse ? false : {};                     // sometimes you want to return false in situations where blpop fails, othertimes you want an empty object (for templating)
        } 
        cb(err);                                                    // if we have err it will return it callback, otherwise err will be null
      }
    }
  );
}
function timeLimit(cb) {                                            // Since blocking functions have a min block of 1 sec, we can just short circuit this
  setTimeout(function() {
    cb();
  },100);                                                           // wait a max if 100ms
}
function passErr(cb) {                                              // a standard way of passing back an error - used multiple times throughout
  return function(err) { cb(err); };
}
function sessionDoneMiddlewareParallel() {                          // This will enable multiple blpop waits to occur at one time. You pass in your arguments in a nested array
  const tasks = Array.prototype.slice.call(arguments);              // convert the first level of arguments into arrays
  return function(req,res,next) {                                   // return a middleware
    async.race([                                                    // async race is for a "whatever finishes first" situation - in this case it's the timeout OR the blpop completion
        timeLimit,                                                  // `timelimit` is 100ms
        function(cb) {                                              // this *only* runs the parallel tasks
          async.parallel(                                           // run all the tasks at the same time and finish only once all have completed
            tasks.map(function(aTask) {                             // put the tasks in the correct format
              return async.apply(sessionDone,aTask[0],aTask[1],aTask[2],req);
            }),
            passErr(cb)                                             // pass the error for the async.parallel
          );
        }
      ],
      passErr(next)                                                 // pass the error for the async.race
    );
  };
}



function anyPage(req, res, next) {                                  // this just a generic page view
  req.template = 'anypage';                                         // the generic page template
  
  req.pageData = {                                                  // the the data that will be rendered by PUG/Jade
    page  : req.params.anypage,                                     // the page path itself
    links : req.links                                               // links, if they exist
  };
  next();                                                           // next middleware
}

app.get('/added/:anypage', anyPage);                                // use `anyPage()` for anything matching /added/[anything] - nothing happens here but rendering
app.get('/added-sync/:anypage',                                     // show how different it is when you do a synchronous version 
  sessionDoneMiddlewareParallel(['pageview','sessionInfo']),        // waits for the command 'pageView' with 'req.sessionInfo' as the destination
  anyPage                                                           // then render the page
);


app.get('/confirm-purchase',                                        // `confirm-purchase` page
  db.getFeaturedPagesMiddleware,                                    // get the featured pages from our dummy database
  function(req,res,next) {                                          // middleware
    client.publish(                                                 // redis publish to...
      rk('ss','combo',req.sessionID,req.requestId),                 // ...channel ss:combo:[sessionId]:[requestId]
      '1'                                                           // the value here is more/less irrelevant as we're just trying to trigger the subscriber
    );                                                              // note that I'm not actually confirming that this went through - I don't need the guarantee 
    next();                                                         // immediately invoke the callback - not waiting for redis.
  },
  sessionDoneMiddlewareParallel(                                    // this returns a function - each argument is a command to send
    ['combo','comboResults'],                                       // waits for the command 'combo' with 'req.comboResults' as the destination
    ['pageview','sessionInfo',true]                                 // waits for the command 'pageview' with 'req.sessionInfo' as the destination
  ), 
  function(req,res,next) {
    req.template = 'purchase-page';                                 // purchase page template
    req.pageData = {                                                // populate the template
      page    : 'Confirm Purchase',                                 // with our page title
      suggest : req.comboResults                                    // ...along with the suggestions brought in from `sessionDoneMiddlewareParallel`
    };
    next();                                                         // next middleware
  }
);

// we handle group notifications so we can catch the sessionDone block
app.get(
  '/group-notifications',                                           // GET /group-notifications
  function(req,res,next) {
    if (req.query.seen) {                                           // if it has `?seen=` defined in the URL
      client.publish(                                               // publish a message
        rk('ss','mark-notification-seen',req.sessionID,req.requestId), // channel: ss:mark-notification-seen:[sessionId]:[requestId]
        req.query.seen                                              // message is what comes after `?seen=`
      );
      next();                                                       // next middleware
    } else {
      next('route');                                                // if no `?seen=` then move on, to the next handler
    } 
  },
  sessionDoneMiddlewareParallel(
    ['mark-notification-seen','notificationResponse']               // wait for the results from `mark-notification-seen` and write the results to `req.notificationResponse`
  )
);
// main handler
app.get(
  '/group-notifications',                                           // GET /group-notifications
  db.getGroupNotificationsMiddleware,                               // dummied notification database
  function(req,res,next) {
    client.publish(                                                 // publish to ss:notifications:[sessionId]:[requestId] with the JSON as the payload
      rk('ss','notifications',req.sessionID,req.requestId),JSON.stringify(req.groupNotifications)
    );
    next();                                                         // go on to the next middleware
  },
  sessionDoneMiddlewareParallel( 
    ['pageview','sessionInfo'],                                     // waits for the command 'pageview' with 'req.sessionInfo' as the destination
    ['notifications','groupNotifications']                          // waits for the command 'notifications' with 'req.groupNotifications' as the destination
  ),
  function(req,res,next) {
    if (Array.isArray(req.groupNotifications)) {                    // do we have an array of notifications?
      req.groupNotifications = req.groupNotifications.map(          // if yes, then modify each one
        function(aNotifcation) {                                   
          return { text : aNotifcation, seen : false };             // each notification is a object that has `seen` defaulting to false
        }
      );
    } else {                                                        // if not, we have an JSON object as notifications
      req.groupNotifications = JSON.parse(req.groupNotifications);  // parse it.
    }
    req.template = 'notifications';                                 // define the template
    req.pageData = {
      notifications : req.groupNotifications                        // push the group notifications from the microservice out into the template
    };
    next();                                                         // next middleware
  }
);

app.get(                                                            // GET `/raw-session-analytics` 
  '/raw-session-analytics',
  sessionDoneMiddlewareParallel(['pageview','sessionInfo',true]),   // wait for the command 'pageview' and put the results in `req.sessionInfo` - the third argument signifies that if no result, then the default value is false
  function(req,res) {
    if (req.sessionInfo !== false) {                                // do we have sessionInfo?
      res.send(                                                     // send out raw text
        '<pre>results from session analytics: '+
        JSON.stringify(req.sessionInfo,null, 2)+                    // with the sessionInfo
        '</pre>'
      );
    } else {
      res.send('Session Mircoservice Timed Out');                   // otherwise show this error message 
    }
  }
);


app.get('/',                                                        // the index page
  db.getFeaturedPagesMiddleware,                                    // grab the featured pages from the mock database
  function(req,res,next) {
    client.publish(                                                 // publish the message
      rk('ss','featuredpages',req.sessionID,req.requestId),         // to channel ss:featuredpages:[sessionId]:[requestId]
      JSON.stringify(req.featuredPages)                             // with the message being the info from the featured pages in the mock db
    );
    next();                                                         // and the next middleware
  },
  sessionDoneMiddlewareParallel(
    ['featuredpages','featuredPages'],                              // take the `featuredpages` cmd and put the value into `req.featuredPages`
    ['pageview','sessionInfo']                                      // take the `pageview` cmd and put the value into `req.sessionInfo`
  ),
  function(req,res,next) {
    try {                                                           // try/catch because we might have invalid JSON
      req.featuredPages = JSON.parse(req.featuredPages);
    } catch(e) {
      req.featuredPages = [];                                       // if it's invalid, then just make it an empty array
    }
    
    req.template = 'index';                                         // set the template
    
    req.pageData = {                                                // pass in the information to the template
      featuredPages   : req.featuredPages,                          
      sessionInfo     : req.sessionInfo
    };

    next();                                                         // pass to the next middleware (rendering)
  }
);

function sumArray(arr) {                                            // helper function to sum an array of integers
  return arr.reduce((a, b) => a + b, 0);
}

function renderRoute(req,res,next) {                                // This is our rendering middleware/route
  if (req.template) {                                               // if we have a template passed in, then we render
    let pageData = req.pageData || {};                              // pageData, if it doesn't exist then it's an empty object
    pageData.sessionInfo = req.sessionInfo || {};                   // pass in the session info, which is mainly just the stats

    if (pageData.sessionInfo.totalPages === 1) {                    // is this the first time?
      pageData.notice = 
        'Hi, welcome on your first visit to this site!';
    }

    if ((pageData.sessionInfo.totalPages > 1) &&                    // let's determine if you're inactive - logically you have to have had more views than one!
        (pageData.sessionInfo.activityThisMinute === false) &&      // no activity this minute
        ( sumArray(
            pageData.sessionInfo.activity
          ) === 0)) {                                               // nor the last 5 minutes
      pageData.notice = 'You haven\'t been active in the last 5 minutes :(';
    }
    res.render(                                                     // render the page to pug/jade
      req.template,
      pageData
    );
  } else {
    next();                                                         // otherwise we just skip rendering (and it's a 404)
  }
}

app.use(renderRoute);
app.enable('view cache');                                           // so we don't have to constantly parse the template
app.listen(3379,function() {
  console.log('listening...');
});