## Chinwag-Twilio

Get together for a good old chinwag. Anonymously.

> Noun. chinwag (plural chinwags) (Britain, informal) An informal conversation, usually about everyday matters; a chat, a gossip.

### Demo

Give a call to `+18557725566` to chat with someone,

**OR** become that someone who will be ready to receive a call by registering your number at [https://chinwag.xyz](https://chinwag.xyz)

> Currently only New Zealand & USA phone number are supported for this demo.

### Idea

Amid the current pandemic outbreak, peoples are forced to stay home to break the chain of transmission. But there are some unfortunate people who don't have anyone at their home to rely for help or emotional support. And also there are some who have limited or no access to the internet at their home like in New Zealand. So here is a crowdsourcing phone support.

### Process

1. *John* make a phone call to the phone number.
2. *John* is added to a queue and wait.
3. The backend will ring everyone who set their status as available online.
4. *David* pick up his phone call. 
5. The backend will automatically connect his phone call to *John*, and drop other requested phone calls.

### Prerequisites

1. Twilio account
2. Firebase account
3. IPStack API Key

### Installation

1. `npm install`

2. `cp .env.sample .env` and fill up the details

3. Put your Firebase service account key file as `firebase-key.json`

4. `node index.js`

### Todo

* Use a JavaScript frontend framework like ReactJS for the webpage
* Make it deployable to Firebase Cloud Functions

### License

Licensed under the [MIT license](http://opensource.org/licenses/MIT)
