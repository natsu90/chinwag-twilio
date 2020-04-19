
require('dotenv').config();

const express = require('express'),
	app = express(),
	bodyParser = require('body-parser'),
	request = require('request-promise'),
	phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance(),
	PNF = require('google-libphonenumber').PhoneNumberFormat,
	twilio = require('twilio'),
	client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { 
    	lazyLoading: true 
	}),
	admin = require('firebase-admin'),
	// google = require('googleapis'),
	async = require('async'),

	port = process.env.PORT || 1337,
	queue_name = 'callcenter',
	queue_sid = null

const serviceAccount = require('./firebase-key.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

let db = admin.firestore(),
	users = db.collection('users'),
	logs = db.collection('logs'),
	calls = db.collection('calls')

async function getIpInfo(ip_address) {

	var options = {
        uri: "http://api.ipstack.com/" + ip_address,
        method: "GET",
        qs: {
            access_key : process.env.IP_STACK_KEY,
            format: 1
        },
        json: true
    }

	return await request(options);
}

async function getPhoneInfo(phone_number, ip_address) {

	const ip_info = await getIpInfo(ip_address),
		country_code = ip_info.country_code
		number = phoneUtil.parseAndKeepRawInput(phone_number, country_code)

	return {
		isValidNumber: phoneUtil.isValidNumber(number),
		phone_number: phoneUtil.format(number, PNF.E164)
	}
}

function sendPassword(phone_number) {

	const doc_id = phone_number.replace('+', ''),
		verification_code = Math.floor(1000 + Math.random() * 9000),
		data = {phone_number, verification_code}

	// save data
	users.doc(doc_id).set(data, {merge: true})
	// set status if doesnt exist
	users.doc(doc_id).get().then((doc) => {
		if (typeof doc.get('status') == 'undefined')
			users.doc(doc_id).set({status: 0}, {merge: true})
	})
	// send sms
	client.messages
	  .create({
	     body: verification_code + ' is your verification code',
	     from: process.env.TWILIO_NUMBER,
	     to: phone_number
	   })
	  .then(message => console.log(`Login: ${phone_number} => ${verification_code}`))
}

async function validatePassword(phone_number, verification_code) {

	const doc_id = phone_number.replace('+', ''),
		rand=()=>Math.random(0).toString(36).substr(2),
		token=(length)=>(rand()+rand()+rand()+rand()).substr(0,length),
		auth_token = token(40)

	let user_doc = await users.doc(doc_id).get(),
		user = user_doc.data(),
		data = { auth_token }

	if (user.verification_code == verification_code) {
		// save auth_token
		users.doc(doc_id).set(data, {merge: true})

		return {
			auth_token: auth_token,
			status: user.status
		};
	} else {
		return null;
	}

}

async function updateUserStatus(phone_number, auth_token, status) {

	const doc_id = phone_number.replace('+', '')

	let user_doc = await users.doc(doc_id).get(),
		user = user_doc.data(),
		old_status = user.status,
		message = 'Updated successfully!',
		isError = false,
		data = { status }
	// denied if token mismatched
	if (auth_token != user.auth_token) {
		isError = true
		status = old_status
		message = 'Access denied!'
	} else
	// denied if status is busy
	if (user.status == 2) {
		isError = true
		status = old_status
		message = 'We are busy! Try again later'
	} else {

		users.doc(doc_id).update(data)
	}

	return {status, message, isError};
}

function logRequest (req, res, next) {
	
	const data = req.body

	data._Url = req.originalUrl

	logs.add(data)

	next()
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}))
app.set('trust proxy', true)

app.post('/call', logRequest, (req, res) => {

	const twiml = new twilio.twiml.VoiceResponse()

	twiml.enqueue({
		action: '/dequeue-action',
		waitUrl: '/wait'
	}, queue_name)

	// insert record to calls table
	calls.doc(req.body.CallSid).set({
		from: req.body.From,
		status: 2 // pending status
	})

	// making phone call to available users
	// todo // exclude caller number from available users
	users.where('status', '==', 1).get()
		.then(snapshot => {
		    if (snapshot.empty) {
		      console.log('No matching documents.');
		      return;
		    }  

		    snapshot.forEach(doc => {
		    	// console.log(doc.id, '=>', doc.data());
		    	const user = doc.data()

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

app.post('/wait', logRequest, (req, res) => {

	const twiml = new twilio.twiml.VoiceResponse(),
		queue_size = req.body.CurrentQueueSize,
		queue_position = req.body.QueuePosition

	twiml.say(`You are number ${queue_position} from ${queue_size} in the queue. Please hold.`)
	twiml.play('https://api.twilio.com/cowbell.mp3')

	res.send(twiml.toString())
})

app.post('/dequeue-action', logRequest, (req, res) => { 

	const twiml = new twilio.twiml.VoiceResponse()

	twiml.say('Good bye!')
	// update calls status to complete
	calls.doc(req.body.CallSid).update({
		status: 0
	})

	res.send(twiml.toString())
})

app.post('/endcall-status', logRequest, (req, res) => {

	// update back receiver status to online
	const doc_id = req.body.Called.replace('+', '')

	users.doc(doc_id).update({status: 1})

	res.send('OK')
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

				if (queue.current_size == 0) {

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
						    		update({status: 'completed'})
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
	if (answeredBy == 'machine_start')
		twiml.hangup()
	else
		// dequeue
		twiml.dial({action: '/endcall-status'}).queue({
			url: '/connected-status'
		}, queue_name)

	res.send(twiml.toString())
})

app.get('/', (req, res) => {
	res.sendFile( __dirname + '/index.html')
})

app.post('/login', async (req, res) => {

	const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress

	console.log(`Attempt login from ${ip} using ${req.body.phone_number}`)

	const phone_number = req.body.phone_number,
		phone_info = await getPhoneInfo(phone_number, ip)

	if (phone_info.isValidNumber)
		sendPassword(phone_info.phone_number)

	res.json(phone_info)
})

app.post('/verify', async (req, res) => {
	
	const phone_number = req.body.phone_number,
		verification_code = req.body.verification_code,
		user = await validatePassword(phone_number, verification_code)
		response = {auth_token: null}

		if (user != null) response = user

	res.json(response)
})

app.post('/update-status', async (req, res) => {

	const phone_number = req.body.phone_number,
		auth_token = req.body.auth_token,
		status = parseInt(req.body.status),
		response = await updateUserStatus(phone_number, auth_token, status)

	res.json(response)
})

app.get('/stats', (req, res) => {

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
		res.json(results)
	})
})

// create queue resource
client.queues.create({friendlyName: queue_name, maxSize: 5000})
	.then(queue => console.log(queue.sid))
	.catch((err) => {
		// queue ald exists
		if (err.code == 22003) {
			// assign queue_sid to use later
			client.queues.list({limit: 20})
				.then(queues => queues.forEach((q) => {
					if (queue_name == q.friendlyName)
						queue_sid = q.sid
				}))
			// todo // update maxSize in case ald created way before?
		} else {
			console.error(err.message)
		}
	})

app.listen(port)

console.log('Running Twilio Server on port ' + port);
