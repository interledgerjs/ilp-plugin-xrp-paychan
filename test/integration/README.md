# How to run the integration tests

The integration tests require an instance of rippled:

1) Build the dockerfile in test/integration: `sudo docker build -t my_rippled .`

2) Run the rippled image: `docker run -it -p 5006:5006 -p 6006:6006 -p 51235:51235 my_rippled`

Once your rippled instance is running you can execute the integration tests with `DEBUG=ilp* npm run integration`.