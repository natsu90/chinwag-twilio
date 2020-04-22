
require('dotenv').config();

const express = require('express'),
	app = express(),
	bodyParser = require('body-parser'),
	twilio = require('twilio'),
	client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { 
    	lazyLoading: true 
	}),
	admin = require('firebase-admin'),
	async = require('async'),
	hbs = require('hbs'),

	port = process.env.PORT || 1337,
	queue_name = 'callcenter'

const serviceAccount = require('./firebase-key.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

let db = admin.firestore(),
	users = db.collection('users'),
	logs = db.collection('logs'),
	calls = db.collection('calls')

function logRequest (req, res, next) {
	
	const data = req.body

	data[' _Time'] = new Date().toISOString()
	data[' _URL'] = req.originalUrl

	logs.add(data)

	next()
}

app.set('views', __dirname) 
app.set('view engine', 'hbs')
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}))

app.post('/call', logRequest, (req, res) => {

	const twiml = new twilio.twiml.VoiceResponse()

	let status = 2, // pending status
		country_codes = process.env.WHITELISTED_COUNTRIES.split(',')
	
	// only allow for some countries otherwise hangup
	if (country_codes.indexOf(req.body.CallerCountry) >= 0) {

		twiml.enqueue({
			action: '/dequeue-action',
			waitUrl: '/wait'
		}, queue_name)

	} else {
		status = 0
		twiml.hangup()
	}

	// insert record to calls table
	calls.doc(req.body.CallSid).set({
		' _Time': new Date().toISOString(),
		from: req.body.From,
		status: status
	})

	res.send(twiml.toString())
})

app.post('/wait', logRequest, (req, res) => {

	const twiml = new twilio.twiml.VoiceResponse(),
		queue_size = req.body.CurrentQueueSize,
		queue_position = req.body.QueuePosition

	twiml.say(`You are number ${queue_position} from ${queue_size} in the queue. Please hold.`)
	twiml.play({loop: 2}, '/ringtone')

	// making phone call to available users
	users.where('status', '==', 1).get()
		.then(snapshot => {
		    if (snapshot.empty) {
		      console.log('No matching documents.');
		      return;
		    }  

		    snapshot.forEach(doc => {
		    	// console.log(doc.id, '=>', doc.data());
		    	const user = doc.data()

		    	// skip if caller is registered online
		    	if (user.phone_number == req.body.From)
		    		return;

		    	client.calls.create({
		    		machineDetection: 'Enable',
				  	from: process.env.TWILIO_NUMBER,
				  	to: user.phone_number,
				  	url: `https://${process.env.APP_URL}/startcall-action`
				}).then(call => {
				  // console.log('Your phone should be ringing');
				  // set call_sid in user table
				  doc.ref.set({call_sid: call.sid}, {merge: true})
				}).catch(function (err) {
				  console.error(err.message);
				})
		    });
		})
		.catch(err => {
			console.log('Error getting documents', err);
		});

	res.send(twiml.toString())
})

app.post('/dequeue-action', logRequest, (req, res) => { 

	const twiml = new twilio.twiml.VoiceResponse()

	twiml.hangup()
	// update calls status to complete
	calls.doc(req.body.CallSid).update({
		status: 0
	})

	// hangup other call if queue is empty
	client.queues(req.body.QueueSid).fetch().then((queue) => {

		if (queue.currentSize == 0) {

			users.where('status', '==', 1).get()
				.then(snapshot => {
				    if (snapshot.empty) {
				      console.log('No matching documents.');
				      return;
				    }  

				    snapshot.forEach(doc => {

				    	const user = doc.data()
				    	// send hangup signal on every sid regardless active or not
				    	client.calls(user.call_sid)
				    		.update({status: 'completed'})
				    		.then(call => console.log(`dropping call to ${call.to}`))
				    })
				})
				.catch(err => {
					console.log('Error getting documents', err);
				})
		}
	})

	res.send(twiml.toString())
})

app.post('/endcall-action', logRequest, (req, res) => {
	
	const twiml = new twilio.twiml.VoiceResponse()

	twiml.hangup()
	// update back receiver status to online
	const doc_id = req.body.Called.replace('+', '')

	users.doc(doc_id).update({status: 1})

	res.send(twiml.toString())
})

app.post('/connected-status', logRequest, (req, res) => {

	// update calls table with status & connected user
	calls.doc(req.body.CallSid).update({
		status: 1 // set to in-progress status
	})

	async.series([
		function(cb) {
			// update receiver status to busy & update call record with related user
			users.where('call_sid', '==', req.body.DequeingCallSid).limit(1).get()
				.then(snapshot => {
				    if (snapshot.empty) {
				      console.log('No matching documents.');
				      return;
				    }  

				    const user_ref = snapshot.docs[0].ref,
				    	user = snapshot.docs[0].data()

				    // update receiver status to busy
				    user_ref.update({status: 2})
				    // update call record with receiver number
				    calls.doc(req.body.CallSid).update({
						to: user.phone_number
					})

					cb(null, true)
				})
				.catch(err => {
					// console.log('Error getting documents', err);
					cb(err)
				})
		},
		function(cb) {
			// hangup other call if queue is empty
			client.queues(req.body.QueueSid).fetch().then((queue) => {

				if (queue.currentSize == 0) {

					users.where('status', '==', 1).get()
						.then(snapshot => {
						    if (snapshot.empty) {
						      console.log('No matching documents.');
						      return;
						    }  

						    snapshot.forEach(doc => {

						    	const user = doc.data()
						    	// send hangup signal on every sid regardless active or not
						    	client.calls(user.call_sid)
						    		.update({status: 'completed'})
						    		.then(call => console.log(`dropping call to ${call.to}`))
						    })

						    cb(null, true)
						})
						.catch(err => {
							// console.log('Error getting documents', err);
							cb(err)
						})
				}
			})
		}
	])

	res.send('OK')
})

app.post('/phone-status', logRequest, (req, res) => {

	res.send('OK')
})

app.post('/startcall-action', logRequest, (req, res) => {

	const twiml = new twilio.twiml.VoiceResponse(),
		answeredBy = req.body.AnsweredBy
	// hangup reciever call if answered by machine
	if (answeredBy.indexOf('machine') >= 0)
		twiml.hangup()
	else
		// dequeue
		twiml.dial({action: '/endcall-action'}).queue({
			url: '/connected-status'
		}, queue_name)

	res.send(twiml.toString())
})

app.get('/', (req, res) => {

	async.parallel({
		registered: function(cb) {
			users.get().then((snap) => {
				cb(null, snap.size)
			})
		},
		available: function(cb) {
			users.where('status', '==', 1).get().then((snap) => {
				cb(null, snap.size)
			})
		},
		busy: function(cb) {
			users.where('status', '==', 2).get().then((snap) => {
				cb(null, snap.size)
			})
		},
		calls: function(cb) {
			calls.get().then((snap) => {
				cb(null, snap.size)
			})
		}
	}, function(err, results) {
		
		let data = results

		data.phone_number = process.env.TWILIO_NUMBER
		data.firebase_web_apikey = process.env.FIREBASE_WEB_APIKEY
		data.whitelisted_countries = process.env.WHITELISTED_COUNTRIES

		res.render('index', data)
	})

})

app.post('/update-status', async (req, res) => {

	const phone_number = req.body.phone_number,
		doc_id = phone_number.replace('+', ''),
		auth_token = req.body.auth_token,
		status = parseInt(req.body.status)

	if (auth_token) {
	    admin.auth().verifyIdToken(auth_token).then(() => {
	        users.doc(doc_id).get().then((doc) => {

	        	if (doc.get('status') == 2) // deny if busy
	        		return res.status(400).send('Busy')
	        	else
	        		doc.ref.update({status: status})

	        	res.json({
	        		phone_number: phone_number,
	        		status: status
	        	})
	        })
	    }).catch(() => {
			res.status(403).send('Unauthorized')
		});
	} else {
		res.status(403).send('Unauthorized')
	}
})

app.post('/get-status', (req, res) => {

	const phone_number = req.body.phone_number,
		doc_id = phone_number.replace('+', ''),
		auth_token = req.body.auth_token

	if (auth_token) {
	    admin.auth().verifyIdToken(auth_token).then(() => {
	        users.doc(doc_id).get().then((doc) => {

	        	let status = 0,
	        		data = { phone_number, status }

	        	if (!doc.exists) {
	        		users.doc(doc_id).set(data)
	        	} else {
	        		data.status = doc.get('status')
	        	}

	        	res.json(data)
	        })
	    }).catch(() => {
			res.status(403).send('Unauthorized')
		});
	} else {
		res.status(403).send('Unauthorized')
	}
})

app.get('/ringtone', (req, res) => {

	res.sendFile( __dirname + '/ringtone.mp3')
})

// update webhook URL in account
client.incomingPhoneNumbers
	.list({phoneNumber: process.env.TWILIO_NUMBER, limit: 1})
	.then((incomingPhoneNumbers) => {
		incomingPhoneNumbers.forEach(i => {
			console.log(i.sid)
			client.incomingPhoneNumbers(i.sid).update({
				voiceMethod: 'POST',
				voiceUrl: `https://${process.env.APP_URL}/call`,
				voiceReceiveMode: 'voice',
				statusCallbackMethod: 'POST',
				statusCallback: `https://${process.env.APP_URL}/phone-status`
			})
		})
	})
	.catch(err => console.error(err));

// create queue resource
client.queues.create({friendlyName: queue_name, maxSize: 5000})
	.then(queue => console.log(queue.sid))
	.catch(err => console.error(err.message))

app.listen(port)

console.log('Running Twilio Server on port ' + port);
