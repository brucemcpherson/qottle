# qottle

A queue that supports
- promises/ async await
- concurrency control
- rate limiting and delay
- priorities

These examples all use promise syntax, but obviously you can substitute async/await if you prefer.

## Installation

````
yarn add qottle
````

## Usage

````
const Qottle = require('qottle');

````
You can add actions that need to be performed, and the queue concurrency will allow a number of them to be run concurrently. For example, single threaded queue might be initialized like this
````
const q = new Qottle({
  concurrent: 1
})
````
And add items to it like this
````
queue.add (action, options)
````
For example - with concurrent set to 1, these items will be run 1 after another
````
q.add (()=> doSomething())
q.add (()=> doSomethingElse())
````
Each entry is resolved as a promise, whether or not the original action was a promise - 
````
q.add (()=> console.log('Im running')).then(()=> console.log('ive said im starting'))
q.add (()=> doAnAsyncThing()).then({result} => console.log('the result was', result))
q.add (()=> console.log('its all over'))
````
Or perhaps
````
Promise.all([
  q.add (()=> console.log('Im running')).then(()=> console.log('ive said im starting'))
  q.add (()=> doAnAsyncThing())
  q.add (()=> console.log('its all over'))
]).then([,pack]=> {
  console.log('the result was', pack.result)
})
````
## Skipping duplicates

If you are running something like Pub/sub you often get requests to do something you already know you have to do, are not ready to ack them, but you don't want to add them to the queue. By providing a key for each entry, usually a digest of some kind of parameters you can selectively add things to the queue only if you dont already know about them. 
````
const q = new Qottle({
  skipDuplcates: true
})
````
then add entries to the queue with a key
````
q.add (() => onlyDoOnce ({
  key: someId
}))
````
qottle will skip any add requests with duplicate keys. Normally a duplicate key only applies to items that are either active or in the queue - not completed items. You can set the option 'sticky' to mean you want qottle to keep a record of all keys it has processed in this instance.

## Rate limiting

qottle can help avoid rate limit problems with APIs by applying various rate limit breaking avoidance techniques, such as limiting the number of calls over a given period. See the options section for how this works


## Options
Most options can be applied when the queue is initialized, then individually overriden when an entry is added to the queue.
| option | default | purpose |
| ---- | ---- | ---- |
| concurrent | Infinity | How many items can be run at once |
| skipDuplicates | false | Enables duplicate skipping where items with the same key are not added to the queue  more than once|
| sticky | false | whether to keep a record for skipping duplcates of finished items as well as active or queued items |
| immediate | true | whether to start the queue whenever something is in it, or to wait for it to be explicity started |
| priority | 100 | the order to do things in. Lower values happen before higher values. Where priorities are the same, the order of insertion applies |
| log | false | whether to log console info on starting and finishing items |
| rateLimited | false | whether rate limiting management is required |
| rateLimitPeriod | 60000 | how long to measure rate limiting over |
| rateLimitDelay | 0 | how long to wait between starting each concurrent item |
| rateLimitMax | 1 | how many items to allow to be outstading at once - this is an additional constraint to the concurrent value |
| rateLimitMinWait | 100 | if a delay is required, qottle will calculate how much time is left in the rateLimitPeriod and wait that long before attempting to run. This is the minimum period to wait before trying again. Can be useful where the rate limited API time is slighty out of sync with your client |
| catchError | false | normally a run error will be returned to the add function for you to catch. If catchError is set to true, then qottle will catch the error and pass it to the .then() of add(). See later for examples |


## Events

In addition to the promise resolutions, events can also be triggered. For example
````
  q.on("finish", ({entry}) => {
    console.log(`${entry.key} is finished and ran for ${entry.runTime}ms`)
  });
````

| eventName | triggered on |
| ---- |  ---- |
| empty | queue is empty |
| error | there's been an error for an item |
| finish | an item has finished |
| skip | an item has been skipped as it had a duplicate key |
| start | an item has started |
| startqueue | the queue has started |
| stopqueue | the queue has been stopped |
| stopqueue | the queue has been stopped  - stopped queues still accept additions |
| ratewait | an entry is waiting for an opportunity to run but cant as it would violate a rate limit rule|
| add | an entry is added |

### Event payload

The payloads returned for each event can vary on the type but they are some or all of the following properties

| property | content |
| ---- |  ---- |
| entry | details of the execution and options for an item |
| error | details of an error |
| waitTime | how long a ratelimit constraint will wait before trying again |
| result | the final result returned from the action |

## Entry object

The entry object contains all the options applied plus various other info. It is passed as an argument to every action in the queue - for example
````
q.add (({entry}) => {
  console.log('im executing something for entry', entry.id)
})
````
It also arrives as an argument to most events
````
q.on('start', ({entry}) => {
  console.log('entry just started', entry.id)
})
````
and as part of the completed result of a queue item
````
q.add (({entry}) => {
  console.log('im executing something for entry', entry.id)
}).then(({entry, result})=> {
  console.log('entry', entry.id,'gave me this result', result)
})
````
or
````
q.on('finished', ({entry, result}) => {
  console.log('entry', entry.id,'gave me this result', result)
})
````
Most methods and events return an Entry object that looks like this.

| property | content |
| ---- |  ---- |
| ...options | all the options mentioned earlier |
| status | 'finish', 'error', 'queued', 'active' |
| queuedAt | timestamp when first added |
| startedAt | timestamp when started to run |
| finishedAt | timestamp when finished run |
| elapsed | ms from time queued to time finished |
| runTime | ms it spent actually running |
| id | a unique id |
| waitTime | total ms it spent waiting to run because of a ratelimit constraint |
| waitStartedAt | if forced to wait because of a rate limit constraint this is when it started waiting |
| waitFinishedAt | if forced to wait because of a rate limit constraint this is when it finished waiting and started running |
| waitUntil | if entry is in process of waiting, this is when it will try again |
| attempts | how many times it tried to start |
| action | the function it ran |
| skipped | whether the entry was skipped. Skipped items resolve successfully, but don't run and have this property set to true |
| error | the error if one was thrown. Most useful with catchError: true |


## methods
The are no 'property gets'. All are methods. Where the return value is 'self', you can chain methods.

| property | content | returns |
| ---- |  ---- | ---- |
| add (action : function , options : object) | add to the queue | { result: any, error: Error, entry: Entry} |
| stopQueue() | stop the queue running anything else | self |
| startQueue() | start the queue - items can be added to the queue whether it's started or not | self |
| isStarted() | check if the queue is started | boolean |
| clear() | clear any unstarted queued items | self |
| clearSticky() | clear all items from the sticky history | self |
| clearRateLimitHistory() | clear rate limit history to avoid any outstanding constraint | self |
| remove(entry: Entry) | remove an entry  from the queued items - pass the entry object over| entry || remove(entry) | 
| clearListeners(eventName: string} | clear all the listeners for a given event name. 'all' as the eventName will clear all listeners | self |
| on(eventName: string, listener: function) | add a listener to be executed when a given eventName triggers| Listener |
| off(listener: Listener) | pass over the Listener returned from .on to remove a listener | Listener |

## Rate limiting

A key capability of this queue is to deal with rate limiting. A queue can be set up to throttle calls - often to dela with APIS with rate limits. This is over and above the constraint of 'concurrent' which manages how many queue items can be executed at the same time. 

Let's say you have an API that allows 10 calls per minute, and you don't mind if the they all run simultaneously.
````
const q = new qottle({
  rateLimitPeriod: 10 * 60 * 100,
  rateLimitMax: 10
})
````
Then you can simply add requests to the queue and the queue will submit them according to that rule.
````
Promise.all ([
  q.add (()=>getSome())
  q.add (()=>getSomeMore())
]).then (results=> {
  console.log('all the results', results)
})
````
Another API constraint might be the time between individual calls limited to some value like 20 seconds, and only 1 request being processed at a time.
````
const q = new qottle({
  rateLimitPeriod: 10 * 60 * 100,
  rateLimitMax: 10,
  concurrent: 1,
  rateLimitDelay: 20 * 1000
})
````
Then you can simply add requests to the queue and the queue will submit them according to that rule.
````
Promise.all ([
  q.add (()=>getSome())
  q.add (()=>getSomeMore())
]).then (results=> {
  console.log('all the results', results)
})
````

## Error handling

By default you'll deal with errors like this (all queue items are converted to async)
````
q.add (()=>something())
.then (({result, entry})=>{ ... the result ... })
.catch(({error, entry})=> { ... the error ...})
````
However, you can ask qottle to catch thrown errors.
````
const q = new qottle({
  catchError: true
})
````
Then any errors will be resolved (rather than rejected)
````
q.add (()=>something())
.then (({result, entry, error})=>{ ... the result ... or check for error })
````

### Error event

Irrespective of the catchError options, ````q.on('error', ...)```` will always fire on an error, and ````q.on('finish',...)```` will only trigger on a successful finish. 
````
q.on('error', ({entry,error})=> {
  ... will always trigger on an error
})
````

````
q.on('finish', ({entry,result})=> {
  ... will not trigger on an error
})
````
## Examples 

See the test.js for many examples 

