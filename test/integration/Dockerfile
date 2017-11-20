FROM ubuntu:14.04

# install rippled
RUN apt-get update \
	&& apt-get install -y yum-utils alien \
	&& rpm -Uvh https://mirrors.ripple.com/ripple-repo-el7.rpm \
	&& yumdownloader --enablerepo=ripple-stable --releasever=el7 rippled \
	&& alien -i --scripts rippled*.rpm  \
	&& rm rippled*.rpm

ADD ./rippled.cfg /etc/

# peer_port
EXPOSE 51235
# websocket_public_port
EXPOSE 5006
# websocket_port (trusted access)
EXPOSE 6006

CMD /opt/ripple/bin/rippled -a --start --conf "/etc/rippled.cfg"
